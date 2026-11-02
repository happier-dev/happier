import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ActionExecutorContext, MachineAgentIsolationOwnStatusV1, MachineAgentIsolationStatusV1 } from '@happier-dev/protocol';
import { readHostReviewedChildReceivingAdmissionV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import type { HostAgentIsolationLaunchKind } from './agentIsolationLaunchKind';
import type { SessionMcpLocalContext } from '@/mcp/runtime/sessionMcpLocalTransport';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import { RequesterWorkAttributionV1Schema } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';
import { logger } from '@/ui/logger';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { AgentIsolationMemberNativeIdentity } from './agentIsolationNativeIdentity';
import type { AgentLaunchMaterialization } from './agentLaunchMaterials';
import type { AgentIsolationDaemonObservation, AgentIsolationMemberRequester } from './provisioning';

/** Produced only by the original Action ingress after its complete root/effect
 * verification. An authorization object copied from another context is not proof. */
export type VerifiedExternalActionRequester = Readonly<{
    authorization: ExternalActionExecutionAuthorizationV1;
    isCurrent: () => Promise<boolean>;
}>;

/** Captured only by authenticated private root ingress; never an Action/RPC DTO. */
export type AuthenticatedLocalRootCustody = Readonly<{
    serverIdentityId: string;
    accountId: string;
    machineId: string;
    installationId: string;
}>;

/** Host child ingress has verified its exact admitted packet/job. Reconciles a
 * retained root binding, never grants an execution role or changes provenance. */
export type VerifiedReceivingChild = Readonly<{
    actorAccountId: string;
    custodianAccountId: string;
    machineId: string;
    installationId: string;
}>;

const verifiedOriginalRequester = Symbol('verifiedOriginalActionRequester');
type VerifiedRequesterAuthorization = ExternalActionExecutionAuthorizationV1 & {
    [verifiedOriginalRequester]?: VerifiedExternalActionRequester;
};

/** Keep the ingress proof with its incumbent authorization when approval replay
 * rebuilds the Action context. Neither JSON nor a requester projection can mint it. */
export function retainVerifiedExternalActionRequester(
    proof: VerifiedExternalActionRequester,
): ExternalActionExecutionAuthorizationV1 {
    const authorization: ExternalActionExecutionAuthorizationV1 = { ...proof.authorization };
    for (const key of Reflect.ownKeys(proof.authorization)) {
        if (key === verifiedOriginalRequester) continue;
        const descriptor = Object.getOwnPropertyDescriptor(proof.authorization, key);
        if (descriptor) Object.defineProperty(authorization, key, descriptor);
    }
    Object.defineProperty(authorization, verifiedOriginalRequester, {
        value: { authorization, isCurrent: proof.isCurrent } satisfies VerifiedExternalActionRequester,
        enumerable: false,
    });
    return Object.freeze(authorization);
}

/** Read only the self-bound host proof retained by its original ingress owner. */
export function readRetainedVerifiedExternalActionRequester(
    authorization?: ExternalActionExecutionAuthorizationV1,
): VerifiedExternalActionRequester | undefined {
    const proof = (authorization as VerifiedRequesterAuthorization | undefined)?.[verifiedOriginalRequester];
    return proof?.authorization === authorization ? proof : undefined;
}

export type HostRequesterExecutionIdentity =
    /** Legacy tag for a present custodian or admitted Machine Manage grantee. */
    | Readonly<{ kind: 'owner_person'; requester: RequesterWorkAttributionV1 }>
    | Readonly<{ kind: 'isolated'; requester: RequesterWorkAttributionV1; separationRequired: boolean;
        /** Verified present person, not a Session/Agent execution source. */
        presentPerson?: true;
        /** Verified Account automation, not a Session/Agent execution source. */
        accountAutomation?: true }>
    | Readonly<{ kind: 'unknown'; reason: 'requester_authority_unavailable' | 'session_requester_unavailable' }>;

type HostAgentIsolationRefusalReason = Extract<HostRequesterExecutionIdentity, { kind: 'unknown' }>['reason']
    | Extract<MachineAgentIsolationStatusV1, { kind: 'unavailable' }>['code']
    | 'owner_person_authority_required' | 'member_isolation_required' | 'launch_probe_failed'
    | 'workspace_not_ready' | 'unsupported_platform' | 'agent_launch_kind_unavailable';

function throwNativeAdmissionRefusal(error: PluginError, reason: HostAgentIsolationRefusalReason,
    launchKind?: HostAgentIsolationLaunchKind): never {
    try {
        logger.warnLocalFile('[P11] Native execution admission refused', { code: error.code, reason,
            ...(launchKind ? { launchKind } : {}), phase: 'native_execution_admission' });
    } catch { /* File diagnostics cannot replace the original no-effect refusal. */ }
    throw error;
}

type HostRequesterActionContext = Readonly<Pick<RpcHandlerContext,
    'machineAdmission' | 'verifyMachineAdmissionCurrent' | 'callerInputAuthorization' | 'sessionActionOrigin'
    | 'requesterSessionBootstrap' | 'localActionContext'> & {
        authority?: RpcHandlerContext['callerAuthority']; signal?: AbortSignal;
        /** Retained nested host context when a local delegation also supplies its own context. */
        inheritedLocalActionContext?: RpcHandlerContext['localActionContext'];
        actionCaller?: NonNullable<RpcHandlerContext['localActionContext']>['actionCaller'];
        requesterWorkAttributionV1?: RequesterWorkAttributionV1;
        externalActionExecutionAuthorization?: RpcHandlerContext['callerInputAuthorization'];
        verifiedExternalActionRequester?: VerifiedExternalActionRequester;
        authenticatedLocalRootCustody?: AuthenticatedLocalRootCustody;
    }>;

/** Restore only host-private proof, never replace an existing receipt or guard. */
export function projectVerifiedExternalActionRequesterContext<T extends HostRequesterActionContext>(context: T): T {
    const proof = readRetainedVerifiedExternalActionRequester(context.externalActionExecutionAuthorization);
    if (!proof || context.verifiedExternalActionRequester && context.verifyMachineAdmissionCurrent) return context;
    return { ...context, verifiedExternalActionRequester: context.verifiedExternalActionRequester ?? proof,
        ...(!context.machineAdmission && !context.verifyMachineAdmissionCurrent
            ? { verifyMachineAdmissionCurrent: proof.isCurrent } : {}) };
}

type HostAccountMachineCustody = Readonly<{
    accountId: string; custodianAccountId: string; machineId: string; installationId: string;
}>;

/** Host-private authority, never a request DTO or a caller-selected identity. */
export type HostRequesterExecutionIdentityInput = Readonly<{
    rpcContext?: RpcHandlerContext;
    actionContext?: HostRequesterActionContext;
    /** null is an observed unavailable binding; undefined permits verified closed binding qualification. */
    hostHomeServerIdentityId?: string | null;
    /** Verified physical receiver custody for routed work whose stamp retains its original child. */
    hostCustodianAccountId?: string | null;
    hostExecutionTarget?: Readonly<{ machineId: string; installationId: string }>;
    /** Already verified receiving child; physical custody still decides ownership. */
    verifiedReceivingChild?: VerifiedReceivingChild;
    /** Closed host composition only: same stored Account, authenticated current
     * Machine row and local installation, independently bound to the held Home.
     * This is Agent custody, never present-person proof or historical birth. */
    hostAccountAgent?: HostAccountMachineCustody;
    /** Closed ordinary API CLI workflow; authenticated API self, actual current
     * Machine/local installation and held Home, never a Session's bearer source. */
    hostAccountAutomation?: HostAccountMachineCustody;
    sessionRequester?: RequesterWorkAttributionV1;
    /** Retained birth Home, independent of attribution.serverId's saved-profile handle. */
    sessionRequesterHomeServerIdentityId?: string | null;
    /** Existing trusted Session runner's Machine binding; never inferred from Session ownership. */
    sessionCustodianAccountId?: string | null;
}>;

/** Invocation source survives nested host contexts independently of Account ownership. */
function readHostRequesterInvocationSource(input: Pick<HostRequesterExecutionIdentityInput,
    'rpcContext' | 'actionContext' | 'sessionRequester'>) {
    const context = input.rpcContext ?? input.actionContext;
    const binding = context?.callerInputAuthorization?.binding ?? input.actionContext?.externalActionExecutionAuthorization?.binding;
    const localContexts = [context?.localActionContext, input.actionContext?.inheritedLocalActionContext];
    const sessionOrigin = context?.sessionActionOrigin ?? binding?.sessionActionOrigin
        ?? input.actionContext?.externalActionExecutionAuthorization?.binding.sessionActionOrigin
        ?? localContexts.find(local => local?.externalActionExecutionAuthorization?.binding.sessionActionOrigin)
            ?.externalActionExecutionAuthorization?.binding.sessionActionOrigin;
    const isSessionCaller = (caller: HostRequesterActionContext['actionCaller']) => caller?.kind === 'session'
        || caller?.kind === 'workflowRun' && caller.authorization.principal.kind === 'session';
    const bindings = [binding, input.actionContext?.externalActionExecutionAuthorization?.binding,
        ...localContexts.map(local => local?.externalActionExecutionAuthorization?.binding)];
    return {
        sessionOrigin,
        agentSource: !!input.sessionRequester || !!sessionOrigin || !!context?.requesterSessionBootstrap
            || localContexts.some(local => isSessionCaller(local?.actionCaller) || !!local?.requesterWorkAttributionV1)
            || isSessionCaller(input.actionContext?.actionCaller) || !!input.actionContext?.requesterWorkAttributionV1
            || bindings.some(candidate => candidate?.workflowActionOrigin?.sessionAuthority?.authorization.principal.kind === 'session'),
        inheritedAutomation: localContexts.some(local => local?.authority === 'account_automation'),
    };
}

/** Adapt only host-retained original ingress to the local invocation predicate.
 * Session source and nested automation remain automation, even under a person-shaped outer context. */
export function projectVerifiedExternalActionHostInvocation(
    context: ActionExecutorContext & HostRequesterActionContext,
): ActionExecutorContext | undefined {
    if (!context.externalActionExecutionAuthorization) return context;
    if (!readRetainedVerifiedExternalActionRequester(context.externalActionExecutionAuthorization)) return undefined;
    const source = readHostRequesterInvocationSource({ actionContext: context });
    if (source.agentSource || source.inheritedAutomation) return undefined;
    return { ...context, externalActionExecutionAuthorization: undefined };
}

/** Project ingress-owned child evidence; public/serialized child-shaped data
 * cannot carry the private requester facet or reviewed-child issuer proof. */
function readVerifiedReceivingChild(input: HostRequesterExecutionIdentityInput): VerifiedReceivingChild | null {
    if (input.verifiedReceivingChild) return input.verifiedReceivingChild;
    const reviewed = readHostReviewedChildReceivingAdmissionV1(
        input.rpcContext?.reviewedChildActionContext ?? input.rpcContext?.localActionContext ?? input.actionContext);
    if (reviewed) return reviewed;
    const authorization = (input.rpcContext ?? input.actionContext)?.callerInputAuthorization
        ?? input.actionContext?.externalActionExecutionAuthorization;
    const child = readRequesterAccountActionContext(authorization)?.deploymentChild;
    const target = input.hostExecutionTarget;
    if (!authorization || !child || !input.hostCustodianAccountId || !target
        || child.machineId !== target.machineId || child.installationId !== target.installationId) return null;
    return { actorAccountId: authorization.binding.accountId, custodianAccountId: input.hostCustodianAccountId,
        machineId: child.machineId, installationId: child.installationId };
}

/** Presence and Account equality come from verified ingress, never command/Session operands. */
export function selectHostRequesterExecutionIdentity(input: HostRequesterExecutionIdentityInput): HostRequesterExecutionIdentity {
    if (input.actionContext) input = { ...input,
        actionContext: projectVerifiedExternalActionRequesterContext(input.actionContext) };
    const unknown = (reason: Extract<HostRequesterExecutionIdentity, { kind: 'unknown' }>['reason']): HostRequesterExecutionIdentity =>
        ({ kind: 'unknown', reason });
    const context = input.rpcContext ?? input.actionContext;
    if (input.hostCustodianAccountId === null || input.hostHomeServerIdentityId === null)
        return unknown('requester_authority_unavailable');
    const hostAccount = input.hostAccountAgent ?? input.hostAccountAutomation;
    if (hostAccount) {
        if (input.hostAccountAgent && input.hostAccountAutomation || context || input.sessionRequester || !input.hostHomeServerIdentityId
            || !hostAccount.custodianAccountId) return unknown('requester_authority_unavailable');
        const requester = RequesterWorkAttributionV1Schema.safeParse({
            serverId: input.hostHomeServerIdentityId, accountId: hostAccount.accountId,
            machineId: hostAccount.machineId, installationId: hostAccount.installationId,
        });
        if (!requester.success) return unknown('requester_authority_unavailable');
        return { kind: 'isolated', requester: requester.data,
            separationRequired: requester.data.accountId !== hostAccount.custodianAccountId,
            ...(input.hostAccountAutomation ? { accountAutomation: true as const } : {}) };
    }
    const admission = context?.machineAdmission;
    const session = input.sessionRequester && RequesterWorkAttributionV1Schema.safeParse(input.sessionRequester);
    if (input.sessionRequester && !session?.success) return unknown('session_requester_unavailable');
    const originalRequester = input.actionContext?.verifiedExternalActionRequester;
    const binding = context?.callerInputAuthorization?.binding ?? input.actionContext?.externalActionExecutionAuthorization?.binding;
    const home = binding?.serverIdentityId ?? input.hostHomeServerIdentityId;
    if (binding && input.hostHomeServerIdentityId && binding.serverIdentityId !== input.hostHomeServerIdentityId)
        return unknown('requester_authority_unavailable');
    if (context?.signal?.aborted) return unknown('requester_authority_unavailable');
    const { agentSource, inheritedAutomation, sessionOrigin } = readHostRequesterInvocationSource(input);
    if (session?.success && (!input.sessionRequesterHomeServerIdentityId
        || home && input.sessionRequesterHomeServerIdentityId !== home)) return unknown('session_requester_unavailable');
    if (!context && session?.success) {
        return { kind: 'isolated', requester: session.data,
            separationRequired: !home || !input.sessionCustodianAccountId || session.data.accountId !== input.sessionCustodianAccountId };
    }
    const localContexts = [context?.localActionContext, input.actionContext?.inheritedLocalActionContext];
    const local = !admission && !binding && !originalRequester && !agentSource
        && !input.actionContext?.externalActionExecutionAuthorization
        && !localContexts.some(value => value?.externalActionExecutionAuthorization)
        ? input.actionContext?.authenticatedLocalRootCustody
            ?? localContexts.find(value => value?.authenticatedLocalRootCustody)?.authenticatedLocalRootCustody
        : undefined;
    if (local && (local.serverIdentityId !== input.hostHomeServerIdentityId
        || local.accountId !== input.hostCustodianAccountId
        || local.machineId !== input.hostExecutionTarget?.machineId
        || local.installationId !== input.hostExecutionTarget.installationId)) return unknown('requester_authority_unavailable');
    if ((!local && !context?.verifyMachineAdmissionCurrent) || !home) return unknown('requester_authority_unavailable');
    // Supported older Homes and direct authenticated Action HTTP do not carry a
    // raw-RPC receipt. Their ORIGINAL verified root explicitly names the actor
    // and custodian. Reconcile it with the held physical receiver, never infer
    // a requester from daemon credentials or fabricate a Machine role.
    const root = originalRequester?.authorization.binding;
    if (!admission && !local && (!root || !binding || !isDeepStrictEqual(root, binding)
        || input.hostHomeServerIdentityId !== root.serverIdentityId
        || input.hostCustodianAccountId !== root.custodianAccountId
        || input.hostExecutionTarget?.machineId !== root.machineId
        || input.hostExecutionTarget.installationId !== root.installationId)) return unknown('requester_authority_unavailable');
    const custody = admission ?? (root && { actorAccountId: root.accountId, custodianAccountId: root.custodianAccountId,
        machineId: root.machineId, installationId: root.installationId })
        ?? (local && { actorAccountId: local.accountId, custodianAccountId: local.accountId,
            machineId: local.machineId, installationId: local.installationId });
    if (!custody) return unknown('requester_authority_unavailable');
    const verifiedChild = readVerifiedReceivingChild(input);
    const retainedReceivingChild = verifiedChild?.actorAccountId === custody.actorAccountId
        && verifiedChild.custodianAccountId === custody.custodianAccountId
        && verifiedChild.machineId === custody.machineId
        && verifiedChild.installationId === custody.installationId;
    if (binding && (binding.accountId !== custody.actorAccountId || !retainedReceivingChild
        && (binding.machineId !== custody.machineId || binding.installationId !== custody.installationId
            || binding.custodianAccountId !== custody.custodianAccountId)))
        return unknown('requester_authority_unavailable');
    if (sessionOrigin && !session?.success) return unknown('session_requester_unavailable');
    const target = input.hostExecutionTarget ?? custody;
    const requester = session?.success ? session.data : {
        serverId: home, accountId: custody.actorAccountId, machineId: target.machineId, installationId: target.installationId,
    };
    if ((!session?.success && requester.serverId !== home)
        || requester.machineId !== target.machineId || requester.installationId !== target.installationId)
        return unknown('session_requester_unavailable');
    const owner = requester.accountId === (input.hostCustodianAccountId ?? custody.custodianAccountId);
    const authority = input.rpcContext?.callerAuthority ?? input.actionContext?.authority
        ?? (local ? context?.localActionContext?.authority : undefined);
    const presentPerson = !agentSource && authority === 'present_user' && !inheritedAutomation;
    // Manage is full control of this physical Machine. Consume the admitted
    // role, never a role on another Machine or copied Agent/Session custody.
    // Approval replay retains Home's verified original root instead of raw RPC
    // admission. Both carry the same admitted role; raw admission takes precedence.
    const manager = !agentSource && (admission?.role ?? root?.admittedMachineRole) === 'manage'
        && custody.actorAccountId === requester.accountId
        && custody.machineId === target.machineId && custody.installationId === target.installationId
        && custody.custodianAccountId === (input.hostCustodianAccountId ?? custody.custodianAccountId);
    const unrestricted = owner || manager;
    if (presentPerson && unrestricted) return { kind: 'owner_person', requester };
    return { kind: 'isolated', requester, separationRequired: !unrestricted,
        ...(presentPerson ? { presentPerson: true as const } : {}),
        ...(!agentSource && authority === 'account_automation' ? { accountAutomation: true as const } : {}) };
}

/** Custodian and admitted Manage Account automation retain typed operations, not
 * person break-glass. Genuine Agent/Session custody never qualifies by role or Account equality. */
export function isHostRequesterUnrestrictedOwner(identity: HostRequesterExecutionIdentity): boolean {
    return identity.kind === 'owner_person' || identity.kind === 'isolated'
        && !identity.separationRequired && identity.accountAutomation === true;
}

/** Placement follows the same Machine launch policy; it grants no person or
 * filesystem authority. Required member separation never becomes a fallback. */
export function resolveHostRequesterAgentPlacementForHost(input: Readonly<{
    identity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>;
    snapshot?: Pick<HostAgentIsolationLaunchSnapshot, 'enabled' | 'memberProvisioning'>;
}>): 'daemon' | 'sharedAgent' | 'member' {
    if (input.identity.separationRequired) return 'member';
    if (!input.snapshot?.enabled) return 'daemon';
    return input.snapshot.memberProvisioning === 'linuxUsersV1' ? 'member' : 'sharedAgent';
}

function assertHostIsolationLaunchKindSupported(
    launchKind: HostAgentIsolationLaunchKind | undefined,
    refuse: (reason: 'unsupported_platform' | 'agent_launch_kind_unavailable') => never,
): void {
    if (launchKind === 'managedService' || launchKind === 'attach') {
        return refuse(process.platform !== 'linux' ? 'unsupported_platform' : 'agent_launch_kind_unavailable');
    }
}

/** Canonical early check also runs before native environment hooks can execute. */
export function assertHostRequesterExecutionAdmissionForHost(input: Readonly<{
    identity?: HostRequesterExecutionIdentity;
    personBreakGlass?: boolean;
    snapshot?: HostAgentIsolationLaunchSnapshot;
    agentLaunchKind?: HostAgentIsolationLaunchKind;
}>): boolean {
    const identity = input.identity;
    const ownerBreakGlass = input.personBreakGlass === true && identity?.kind === 'owner_person';
    if (input.personBreakGlass && !ownerBreakGlass || identity?.kind === 'unknown'
        || identity?.kind === 'isolated' && identity.separationRequired && !input.snapshot?.enabled) {
        const reason = identity?.kind === 'unknown' ? identity.reason : input.personBreakGlass
            ? 'owner_person_authority_required' : 'member_isolation_required';
        throwNativeAdmissionRefusal(new PluginError({ code: 'agent_isolation_unavailable',
            message: 'Requester execution protection is unavailable', retryable: false, details: { reason } }), reason, input.agentLaunchKind);
    }
    if (identity && !ownerBreakGlass && input.snapshot?.enabled && input.snapshot.status.kind !== 'effective') {
        const reason = input.snapshot.status.kind === 'unavailable' ? input.snapshot.status.code : 'launch_probe_failed';
        throwNativeAdmissionRefusal(new PluginError({ code: 'agent_isolation_unavailable',
            message: 'Requester execution protection is unavailable', retryable: false, details: { reason } }), reason, input.agentLaunchKind);
    }
    if (identity && !ownerBreakGlass && input.snapshot?.enabled) {
        const status = input.snapshot.status.kind;
        const launchKind = input.agentLaunchKind;
        assertHostIsolationLaunchKindSupported(launchKind, reason =>
            throwNativeAdmissionRefusal(new PluginError({ code: 'agent_isolation_unavailable',
                message: 'Requester execution protection is unavailable', retryable: false,
                details: { reason, status, ...(launchKind ? { launchKind } : {}) } }), reason, launchKind));
    }
    return ownerBreakGlass;
}

export type { HostAgentIsolationLaunchKind } from './agentIsolationLaunchKind';

export type HostAgentIsolationLaunchSnapshot = Readonly<{
    enabled: boolean;
    /** Explicit owner-reviewed future member creation; legacy enablement is not consent. */
    memberProvisioning?: 'linuxUsersV1';
    /** A prepared member operation carries its own observed readiness, without
     * claiming that the Machine's shared agent user is effective. */
    status: MachineAgentIsolationStatusV1 | Extract<MachineAgentIsolationOwnStatusV1, { protection: 'member_separated' }>['status'];
    /** Canonical Workspace-owner facts, never caller-supplied cwd enrollment. */
    workspaceRoots: readonly string[];
    /** Existing native setup observation, captured once by the operation owner. */
    daemonObservation?: AgentIsolationDaemonObservation | null;
    memberIdentity?: AgentIsolationMemberNativeIdentity;
    localTransport?: Readonly<{ agentUid: number; agentGid?: number; runtimeRoot?: string }>;
    launch?: Readonly<{
        managedHappierBinaryPath: string;
        runtimeHome: string;
        selectedEnvironmentKeys: readonly string[];
        environment?: Readonly<Record<string, string>>;
        selectedMaterials: readonly Readonly<{ relativePath: string; contentBase64: string }>[];
        /** Live Session lease output; never Machine metadata or general env. */
        sessionMcpContext?: SessionMcpLocalContext;
    }>;
}>;

/** A read of the existing daemon/Workspace authorities; no independent store. */
export type HostAgentIsolationLaunchContext = Readonly<{
    requesterIdentity?: HostRequesterExecutionIdentity;
    /** Native Session custody is demanded before effects, not at service construction. */
    resolveRequesterIdentity?(signal?: AbortSignal): Promise<HostRequesterExecutionIdentity>;
    managedHappierBinaryPath?: string;
    /** Existing custodian-authorized setup owner. This does not admit a requester. */
    prepareMember?(input: Readonly<{ requesterIdentity: AgentIsolationMemberRequester;
        rpcContext?: RpcHandlerContext; signal?: AbortSignal }>): Promise<Readonly<{
        identity: AgentIsolationMemberNativeIdentity; daemonObservation: AgentIsolationDaemonObservation;
    }>>;
    /** Identity custody also exists when the optional Machine policy/transport
     * port is absent. Absence is not a disabled or effective policy snapshot. */
    read(): HostAgentIsolationLaunchSnapshot | undefined;
    /** The exact Session lease supplies material and live MCP authority. */
    prepareLaunch?(input: Readonly<{ requesterIdentity?: HostRequesterExecutionIdentity; sessionMcpContext?: SessionMcpLocalContext;
        agentNativeLaunch?: boolean;
        mcpLaunchMaterial?: AgentLaunchMaterialization & Readonly<{
            nativeIdentity: Pick<AgentIsolationMemberNativeIdentity, 'agentUid' | 'agentGid' | 'home'>;
        }>;
        signal?: AbortSignal }>): Promise<HostAgentIsolationLaunchContext>;
}>;

/** One captured identity proof; the same lazy owner rechecks its custody after
 * awaited preparation. A previously resolved value cannot suppress withdrawal. */
export async function resolveHostRequesterExecutionIdentityForLaunch(input: Readonly<{
    context?: HostAgentIsolationLaunchContext; requesterIdentity?: HostRequesterExecutionIdentity; signal?: AbortSignal;
}>): Promise<HostRequesterExecutionIdentity | undefined> {
    input.signal?.throwIfAborted();
    const current = input.context?.resolveRequesterIdentity ? await input.context.resolveRequesterIdentity(input.signal) : undefined;
    if (input.requesterIdentity && input.context?.resolveRequesterIdentity && !isDeepStrictEqual(input.requesterIdentity, current)) {
        input.signal?.throwIfAborted();
        return current?.kind === 'unknown' ? current : { kind: 'unknown', reason: 'requester_authority_unavailable' };
    }
    const identity = input.requesterIdentity ?? (input.context?.resolveRequesterIdentity
        ? current ?? { kind: 'unknown' as const, reason: 'requester_authority_unavailable' as const } : input.context?.requesterIdentity);
    input.signal?.throwIfAborted();
    return identity;
}

/** Called only by the shared Exec tuple finalizer, after executable admission. */
export async function admitAgentIsolationLaunchForHost(input: Readonly<{
    context?: HostAgentIsolationLaunchContext;
    cwd?: string;
    /** Original host-admitted path, before Exec resolves a caller's cwd. */
    requestedCwd?: string;
    agentNativeLaunch?: boolean;
    agentLaunchKind?: HostAgentIsolationLaunchKind;
    /** Derived by host Exec from a Machine-native invocation and its declared system tool. */
    hostNativeSystemTool?: boolean;
    sessionMcpContext?: SessionMcpLocalContext;
    mcpLaunchMaterial?: NonNullable<Parameters<NonNullable<HostAgentIsolationLaunchContext['prepareLaunch']>>[0]>['mcpLaunchMaterial'];
    signal?: AbortSignal;
    requesterIdentity?: HostRequesterExecutionIdentity;
    personBreakGlass?: boolean;
}>): Promise<Readonly<{ snapshot: HostAgentIsolationLaunchSnapshot; cwd: string }> | undefined> {
    const identity = await resolveHostRequesterExecutionIdentityForLaunch(input);
    if (input.personBreakGlass) {
        assertHostRequesterExecutionAdmissionForHost({ identity, personBreakGlass: true, agentLaunchKind: input.agentLaunchKind });
        return undefined;
    }
    const snapshot = input.context?.read();
    assertHostRequesterExecutionAdmissionForHost({ identity, snapshot,
        agentLaunchKind: input.agentLaunchKind ?? (input.agentNativeLaunch ? 'exec' : undefined) });
    if (!snapshot?.enabled) return undefined;
    // Typed Machine administration has no Workspace. Do not derive a root from
    // the daemon's cwd; explicit cwd and Agent/Project intent still require proof.
    if (!identity && input.hostNativeSystemTool && input.cwd === undefined && input.requestedCwd === undefined
        && !input.agentNativeLaunch && input.agentLaunchKind === undefined) return undefined;
    const launchKind = input.agentLaunchKind ?? (input.agentNativeLaunch ? 'exec' : 'workspaceExec');
    const code = identity || input.agentNativeLaunch ? 'agent_isolation_unavailable' : 'workspace_exec_isolation_unavailable';
    const refuse = (reason: HostAgentIsolationRefusalReason): never => {
        throwNativeAdmissionRefusal(new PluginError({ code, message: 'Agent isolation cannot admit this launch', retryable: false,
            details: { reason, status: snapshot.status.kind, launchKind } }), reason, launchKind);
    };
    const requestedCwd = input.requestedCwd ?? input.cwd ?? process.cwd();
    if (!isAbsolute(requestedCwd) || requestedCwd.includes('\u0000')) return refuse('workspace_not_ready');
    const canonicalCwd = await realpath(input.cwd ?? requestedCwd).catch(() => null);
    if (!canonicalCwd || snapshot.workspaceRoots.length === 0) return refuse('workspace_not_ready');
    let workspaceExec = false;
    for (const root of snapshot.workspaceRoots) {
        if (!isAbsolute(root)) return refuse('workspace_not_ready');
        const canonicalRoot = await realpath(root).catch(() => null);
        if (!canonicalRoot) return refuse('workspace_not_ready');
        const lexicalMatch = isCanonicalAbsolutePathInsideRoot(root, requestedCwd);
        const canonicalMatch = isCanonicalAbsolutePathInsideRoot(canonicalRoot, canonicalCwd);
        if (lexicalMatch && !canonicalMatch) return refuse('workspace_not_ready');
        workspaceExec ||= canonicalMatch;
    }
    // An explicit kind is issued by a trusted native/Project owner. Its admitted
    // Workspace can belong to a different requester from the daemon's held
    // Account projection; absence there must never downgrade it to host code.
    if (!identity && !input.agentNativeLaunch && input.agentLaunchKind === undefined && !workspaceExec) return undefined;
    if (process.platform !== 'linux') return refuse('unsupported_platform');
    if (snapshot.status.kind !== 'effective') return refuse(snapshot.status.kind === 'unavailable'
        ? snapshot.status.code : 'launch_probe_failed');
    assertHostIsolationLaunchKindSupported(launchKind, refuse);
    if (input.context?.prepareLaunch) {
        const prepared = await input.context.prepareLaunch({ requesterIdentity: identity, sessionMcpContext: input.sessionMcpContext,
            mcpLaunchMaterial: input.mcpLaunchMaterial, agentNativeLaunch: input.agentNativeLaunch, signal: input.signal });
        // Recheck current held policy/roots after the asynchronous lease/OS read,
        // without preparing again or downgrading a native launch to host Exec.
        return admitAgentIsolationLaunchForHost({ ...input, requesterIdentity: identity, context: {
            read: prepared.read,
            ...(input.context.resolveRequesterIdentity ? { resolveRequesterIdentity: input.context.resolveRequesterIdentity } : {}),
        } });
    }
    if (!snapshot.launch || !snapshot.localTransport) return refuse('launch_probe_failed');
    return { snapshot, cwd: canonicalCwd };
}

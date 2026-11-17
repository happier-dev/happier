import { readDeploymentAuthorizationFailure, refuseDeploymentAuthorization } from '../deploymentAuthorizationFailure';
import { randomUUID } from 'node:crypto';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { WorkspaceSyncSourceExecutionV1Schema } from '@happier-dev/protocol/socketRpc';
import { projectDeploymentChildRoutingV1 } from '@happier-dev/protocol/deployments/deploymentChildRoutingV1';
import type { DeploymentDomainChildRpcV1 } from '@happier-dev/protocol/deployments/deploymentChildRpcV1';
import type { DeploymentDomainHeaderV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { projectHomeAuthorizationHttpFailure } from '@/api/client/homeAuthorizationHttpFailure';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { createActionExecuteFailureError, parseActionExecuteFailure, projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { DEPLOYMENT_DATA_SIZE_ACTION_ID_V1, isDeploymentBackupActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { deploymentOutputValidationFailure } from '../outputValidation';
import { projectDeploymentException } from '../deploymentFailure';
import { isAxiosError } from 'axios';
import axios from '@/api/client/credentialAxios';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { computeEnvironmentSecretLaunchAdmissionDigestV1, EnvironmentSecretLaunchAdmissionBodyV1Schema,
    EnvironmentSecretLaunchAdmissionResultV1Schema, EnvironmentSecretClientBindingsInputV1Schema, MachineConnectorSecretGrantBodyV1Schema,
    MachineConnectorSecretGrantResultV1Schema, MachineConnectorSecretGrantInputV1Schema, machineSecretGrantSubjectKey, parseMachineSecretGrantSubjectKey,
    type EnvironmentSecretLaunchAdmissionBodyV1, type EnvironmentSecretAdmissionRequestV1, type MachineConnectorSecretGrantBodyV1,
    type MachineConnectorSecretGrantSubjectV1, type MachineConnectorSecretGrantInputV1,
    type EnvironmentDomainSecretLaunchAdmissionV1 } from '@happier-dev/deployment-protocol';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createExternalActionMachineRpcExecution, projectExternalActionRequesterHttpAuthorization,
    resolveExternalActionRequesterServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { OwnServerSecretLaunchAdmission, OwnServerSecretLaunchAdmissionRequest } from '@/deployments/targets/ownServer/ownServerDeploymentHostRuntime';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { openMachineSecretGrant, sealMachineSecretGrant } from './machineSecretGrant';
import { assertMachineConnectorSecretInvocationCurrent, type InstalledSecretContext } from './secretInvocationCurrentness';
export { assertDeploymentSecretInvocationCurrent, assertMachineConnectorSecretInvocationCurrent } from './secretInvocationCurrentness';

const refuse = (code: string, cause?: ActionExecuteFailure): never => {
    cause ??= code === 'invalid_action_output' ? deploymentOutputValidationFailure('deployments.secrets.admission', undefined) : undefined;
    throw Object.assign(createActionExecuteFailureError(cause ?? { ok: false, errorCode: code, error: code }), { code, ...(cause ? { cause } : {}) });
};
type HostSecretAdmissionRequest = Omit<OwnServerSecretLaunchAdmissionRequest, 'materialization'> & Readonly<{
    environmentUpdate?: true;
    materialization: OwnServerSecretLaunchAdmissionRequest['materialization']
        | Extract<EnvironmentSecretLaunchAdmissionBodyV1['materialization'], { kind: 'bindings' | 'domain' | 'dataRole' }>;
}>;
type BindingPreparationAdmissionRequest = Omit<HostSecretAdmissionRequest, 'targetLinkId' | 'materialization'> & Readonly<{
    targetLinkId?: string;
    materialization: Extract<EnvironmentSecretLaunchAdmissionBodyV1['materialization'], { kind: 'bindings' }>;
    createRequestHeaders?: (body: unknown) => Promise<Readonly<Record<string, string>>>;
}>;

/** Installed target read. Account credentials authenticate transport; only the installed key opens a grant. */
export async function readEnvironmentSecretLaunchAdmissionForHost(input: OwnServerSecretLaunchAdmissionRequest): Promise<OwnServerSecretLaunchAdmission> {
    const admitted = await readEnvironmentSecretAdmissionForHost(input);
    if (admitted.bindingPreparation) { admitted.release(); return refuse('invalid_action_output'); }
    return admitted;
}

/** Query opens only its private service or exact managed-link binding; Home supplies installed custody. */
export async function readEnvironmentDataRoleLaunchAdmissionForHost(input: Omit<HostSecretAdmissionRequest, 'materialization'> & Readonly<{
    expectedRevision: number;
}> & (Readonly<{ deploymentId: string; service: string }> | Readonly<{ deploymentId?: never; service?: never }>)): Promise<OwnServerSecretLaunchAdmission> {
    const native = input.deploymentId !== undefined && input.service !== undefined;
    if (!native && (input.deploymentId !== undefined || input.service !== undefined)) return refuse('invalid_action_output');
    const admitted = await readEnvironmentSecretAdmissionForHost({ ...input, materialization: native
        ? { kind: 'dataRole', expectedRevision: input.expectedRevision, deploymentId: input.deploymentId, service: input.service }
        : { kind: 'dataRole', expectedRevision: input.expectedRevision, targetLinkId: input.targetLinkId } });
    if (admitted.bindingPreparation || admitted.domainAdmission) { admitted.release(); return refuse('invalid_action_output'); }
    return admitted;
}

/** Domain native work uses the same installation proof, grant reader and release lifetime. */
export async function readEnvironmentDomainSecretLaunchAdmissionForHost(input: Omit<HostSecretAdmissionRequest, 'materialization'> & Readonly<{
    materialization: Extract<EnvironmentSecretLaunchAdmissionBodyV1['materialization'], { kind: 'domain' }>;
}>): Promise<OwnServerSecretLaunchAdmission & Readonly<{ domainAdmission?: EnvironmentDomainSecretLaunchAdmissionV1 }>> {
    const admitted = await readEnvironmentSecretAdmissionForHost(input);
    if (admitted.bindingPreparation) { admitted.release(); return refuse('invalid_action_output'); }
    if (!input.materialization.use && !admitted.domainAdmission) { admitted.release(); return refuse('invalid_action_output'); }
    return admitted;
}

/** The same private admission owner serves explicit manager preparation, never a public inventory. */
export async function readEnvironmentSecretBindingPreparationForHost(input: Omit<BindingPreparationAdmissionRequest, 'materialization'> & Readonly<{
    expectedRevision: number; buildMachineId?: string; domainIds?: readonly string[]; dataRoleTargetLinkIds?: readonly string[];
}>) {
    const admitted = await readEnvironmentSecretAdmissionForHost({ ...input,
        materialization: { kind: 'bindings', expectedRevision: input.expectedRevision,
            ...(input.domainIds?.length ? { domainIds: [...input.domainIds] } : {}),
            ...(input.dataRoleTargetLinkIds?.length ? { dataRoleTargetLinkIds: [...input.dataRoleTargetLinkIds] } : {}),
            ...(input.buildMachineId ? { buildMachineId: input.buildMachineId } : {}) } });
    if (!admitted.bindingPreparation) { admitted.release(); return refuse('invalid_action_output'); }
    return { ...admitted, bindingPreparation: admitted.bindingPreparation };
}

type InstalledSecretHostInput = Pick<OwnServerSecretLaunchAdmissionRequest,
    'signal' | 'serverHttpBaseUrl' | 'machineId' | 'installationId'> & Readonly<{
    credentials: Pick<OwnServerSecretLaunchAdmissionRequest['credentials'], 'token'>;
    context: InstalledSecretContext;
    /** Accepted Domain work, sealed by the existing installed signer for Home's child-purpose owner. */
    deploymentChild?: DeploymentDomainChildRpcV1;
    /** Existing installed identity location, carried privately across elevation; never a copied seed. */
    installationIdentityFile?: string;
}>;

/** One installed signer, invocation lifetime and HTTP boundary for both Environment and Machine subjects. */
function createInstalledSecretTransportForHost(input: InstalledSecretHostInput,
    createRequestHeaders?: (body: unknown) => Promise<Readonly<Record<string, string>>>) {
    const identity = readInstallationIdentityIfExistsSync(input.installationIdentityFile);
    const accountId = readAccountIdFromToken(input.credentials.token);
    if (!identity || identity.installationId !== input.installationId || !accountId) return refuse('secret_missing');
    let released = false;
    const assertAuthority = async () => {
        if (released) return refuse('secret_missing');
        if (input.signal.aborted) return refuse('cancelled');
    };
    const prepareRequest = async (path: string, body: EnvironmentSecretLaunchAdmissionBodyV1 | MachineConnectorSecretGrantBodyV1
        | Extract<EnvironmentSecretAdmissionRequestV1, { kind: 'clientBindings' }>,
        effectActionId?: string) => {
        await assertAuthority();
        let context = input.context;
        const authorization = context.externalActionExecutionAuthorization;
        if (input.deploymentChild && authorization) {
            const rootHttp = authorization.requesterHttpProjection;
            const target = context.externalActionTarget;
            if (!rootHttp || !target) return refuseDeploymentAuthorization('home_secret_launch_headers_refused');
            const child = input.deploymentChild;
            const method = `${child.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`;
            const requestId = randomUUID();
            const externalActionExecution = createExternalActionMachineRpcExecution({ context: { ...context, operationAcceptance: undefined },
                effectActionId: child.actionId, installationId: identity.installationId, method, requestId, params: child,
                deploymentChildRouting: projectDeploymentChildRoutingV1(child), privateKey: identity.privateKey });
            const packet = WorkspaceSyncSourceExecutionV1Schema.parse({ method, requestId, params: child,
                originalActionEnvelope: context.originalActionEnvelope, externalActionExecution });
            const projected = await projectExternalActionRequesterHttpAuthorization({ authorization,
                serverId: rootHttp.serverId, serverIdentityId: rootHttp.serverIdentityId,
                serverHttpBaseUrl: input.serverHttpBaseUrl, target, installationId: identity.installationId,
                privateKey: identity.privateKey, rootAdmitted: true, forwardedDeploymentChild: child,
                deploymentChildExecution: packet, signal: input.signal });
            if (!projected) return refuseDeploymentAuthorization('home_secret_launch_headers_refused');
            context = { ...context, externalActionExecutionAuthorization: projected };
        }
        const projection = effectActionId ? context.externalActionExecutionAuthorization?.requesterHttpProjection : undefined;
        const data = 'kind' in body ? body : { ...body, proof: signMachineInstallationProof({ payload: { version: 1, machineId: input.machineId,
            installationId: identity.installationId, accountId: projection?.accountId ?? accountId,
            deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } },
            privateKey: identity.privateKey }) };
        const authorizationHeaders = createRequestHeaders ? await createRequestHeaders(data)
            : projection && effectActionId ? await resolveExternalActionRequesterServerRequestHeaders({
                context, serverHttpBaseUrl: input.serverHttpBaseUrl, method: 'POST', path, body: data,
                effectActionId }) : { Authorization: `Bearer ${input.credentials.token}` };
        if (!authorizationHeaders) return refuseDeploymentAuthorization('home_secret_launch_headers_refused');
        const url = `${input.serverHttpBaseUrl}${path}`;
        const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...authorizationHeaders };
        return async (signal: AbortSignal) => {
            try {
                const response = await axios.request<unknown>({ method: 'POST', url, headers, data, signal,
                    maxRedirects: 0, validateStatus: () => true });
                return { response, requestHeaders: headers };
            } catch (error) {
                if (signal.aborted) return refuse('cancelled');
                // Only a request that left and got no response proves Home unreachable;
                // anything else keeps its own classified cause.
                if (isAxiosError(error) && error.response === undefined) return refuse('home_unreachable', {
                    ok: false, errorCode: 'home_unreachable', error: 'home_unreachable',
                    failureCause: projectActionFailureCauseV1(error, 'deployment.secrets.admission.request') });
                const failure = projectDeploymentException(error, { phase: 'deployment.secrets.admission.request' });
                return refuse(failure.errorCode, failure);
            }
        };
    };
    const request = async (path: string, body: EnvironmentSecretLaunchAdmissionBodyV1 | MachineConnectorSecretGrantBodyV1
        | Extract<EnvironmentSecretAdmissionRequestV1, { kind: 'clientBindings' }>,
        effectActionId?: string) => {
        const send = await prepareRequest(path, body, effectActionId);
        const response = await send(input.signal);
        await assertAuthority();
        return response;
    };
    return { identity, request, prepareRequest, assertCurrent: assertAuthority, release() { released = true; } };
}

async function readEnvironmentSecretAdmissionForHost(input: HostSecretAdmissionRequest | BindingPreparationAdmissionRequest) {
    const root = input.context.externalActionExecutionAuthorization?.binding;
    const native = root?.deploymentNativeAdmission;
    const dataRoleRoot = native && 'kind' in native && native.kind === 'restore' ? native.actionId
        : root?.deploymentReadAdmission?.actionId === DEPLOYMENT_DATA_SIZE_ACTION_ID_V1 ? DEPLOYMENT_DATA_SIZE_ACTION_ID_V1 : undefined;
    const actionOperationId = input.actionOperationId ?? input.context.operationAcceptance?.operationId;
    if (input.materialization.kind === 'deployment' && !actionOperationId) return refuse('operation_unavailable');
    const custody = createInstalledSecretTransportForHost(input, 'createRequestHeaders' in input ? input.createRequestHeaders : undefined);
    const body = !input.targetLinkId && input.materialization.kind === 'bindings'
        ? EnvironmentSecretClientBindingsInputV1Schema.parse({ kind: 'clientBindings', serverId: input.serverId,
            environmentId: input.environmentId, expectedRevision: input.materialization.expectedRevision,
            ...(input.materialization.buildMachineId ? { buildMachineId: input.materialization.buildMachineId } : {}),
            ...(input.materialization.domainIds?.length ? { domainIds: input.materialization.domainIds } : {}),
            ...(input.materialization.dataRoleTargetLinkIds?.length
                ? { dataRoleTargetLinkIds: input.materialization.dataRoleTargetLinkIds } : {}) })
        : EnvironmentSecretLaunchAdmissionBodyV1Schema.parse({ serverId: input.serverId,
        environmentId: input.environmentId, targetLinkId: input.targetLinkId,
        machineId: input.machineId, installationId: input.installationId,
        materialization: input.materialization.kind !== 'deployment' ? input.materialization : {
            ...input.materialization, actionOperationId,
        } });
    const read = async () => {
        const { response, requestHeaders } = await custody.request(`/v1/deployments/environments/${encodeURIComponent(input.environmentId)}/secret-launch-admission`,
            body, input.materialization.kind === 'bindings'
                ? input.materialization.buildMachineId || input.environmentUpdate
                    ? 'deployments.environments.update' : 'deployments.bindings.set'
                : input.materialization.kind === 'dataRole'
                    ? dataRoleRoot ?? ('targetLinkId' in input.materialization
                        || input.context.externalActionExecutionAuthorization?.binding.actionId === ACTION_INVOKE_ACTION_ID_V1
                        ? ACTION_INVOKE_ACTION_ID_V1 : 'deployments.data.query')
                : input.materialization.kind === 'domain' && !input.materialization.use
                    ? 'deployments.domains.add'
                    : (input.materialization.kind === 'deployment' || input.materialization.kind === 'copySourceRead') && (input.context.externalActionExecutionAuthorization?.binding.actionId === 'deployments.backups.restore'
                        || isDeploymentBackupActionIdV1(input.context.externalActionExecutionAuthorization?.binding.actionId ?? ''))
                    ? input.context.externalActionExecutionAuthorization?.binding.actionId : undefined);
        const parsed = EnvironmentSecretLaunchAdmissionResultV1Schema.safeParse(response.data);
        if (!parsed.success && (response.status === 401 || response.status === 403)) {
            const failure = projectHomeAuthorizationHttpFailure(response.status, requestHeaders, response.data);
            return refuse(failure.errorCode, failure);
        }
        if (!parsed.success && ![404, 405, 501].includes(response.status)) {
            return refuse('invalid_action_output', deploymentOutputValidationFailure('environment_secret_launch_admission', response.status, parsed.error));
        }
        if (!parsed.success) return refuse(response.status === 404 || response.status === 405 || response.status === 501
            ? 'unsupported_action' : 'invalid_action_output');
        if (!parsed.data.ok) return refuse(parsed.data.error, {
            ok: false, errorCode: parsed.data.error, error: parsed.data.error,
            failureCause: projectActionFailureCauseV1(
                createHttpStatusError(response.status, parsed.data.error, parsed.data.error), 'deployment.secret_launch.admission'),
        });
        if (response.status !== 200) return refuse('invalid_action_output', deploymentOutputValidationFailure('environment_secret_launch_admission', response.status));
        const { grants, bindingPreparation, domainAdmission } = parsed.data;
        return { grants, ...(bindingPreparation ? { bindingPreparation } : {}), ...(domainAdmission ? { domainAdmission } : {}) };
    };
    const admitted = await read();
    return { ...admitted, assertCurrent: custody.assertCurrent, release: custody.release };
}

export type MachineConnectorSecretGrantHostRequest = Omit<InstalledSecretHostInput, 'machineId' | 'installationId'> & Readonly<{
    serverId: string;
    hostMachineId: string;
    hostInstallationId: string;
    subject: MachineConnectorSecretGrantSubjectV1;
    /** P21's current admitted provider/connector/operation, never caller-authored authority. */
    assertCurrent(): Promise<void>;
    /** Same elevated invocation only: the live parent creates headers for this exact signed read. */
    createReadRequestHeaders?: (body: Extract<MachineConnectorSecretGrantInputV1, { operation: 'read' }>) => Promise<Readonly<Record<string, string>>>;
}>;

/** Capture every admitted Domain target; Account code supplies only the connector and token. */
export function bindMachineConnectorSecretsForHost(input: Omit<MachineConnectorSecretGrantHostRequest,
    'subject' | 'hostMachineId' | 'hostInstallationId'> & Readonly<{
    domain: DeploymentDomainHeaderV1;
    domainAdmissions: readonly EnvironmentDomainSecretLaunchAdmissionV1[];
    onGrant?: (grant: Readonly<{ machineId: string; installationId: string; grantRef: string }>) => void;
}>): NonNullable<PluginAccountActionContext['services']['machineConnectorSecrets']> {
    const { domain, domainAdmissions, onGrant, ...host } = input;
    type Write = NonNullable<PluginAccountActionContext['services']['machineConnectorSecrets']>['write'];
    return Object.freeze({
        async write({ token, subject }: Parameters<Write>[0]) {
            const grants: { machineId: string; installationId: string; grantRef: string }[] = [];
            for (const { controller, target, actionOperationId } of domainAdmissions) {
                const capture = domain.placements?.find(item => item.desired
                    && item.placement.machineId === target.machineId && item.placement.installationId === target.installationId
                    && item.placement.actionOperationId === actionOperationId);
                if (!capture) return refuse('target_mismatch');
                const deploymentChild: DeploymentDomainChildRpcV1 = { v: 1, kind: 'domain', actionId: 'deployments.domains.add',
                    input: { serverId: host.serverId, environmentId: domain.environmentId, domainId: domain.id },
                    machineId: target.machineId, installationId: target.installationId,
                    expectedDomainRevision: domain.revision, actionOperationId, capture };
                const written = await writeMachineConnectorSecretGrantForHost({
                    ...host, deploymentChild, context: { ...host.context, operationAcceptance: { operationId: actionOperationId } }, token,
                    installationPublicKey: decodeBase64(target.publicKey, 'base64url'),
                    hostMachineId: controller.machineId, hostInstallationId: controller.installationId,
                    subject: { v: 1, kind: 'connectorToken', machineId: target.machineId,
                        installationId: target.installationId, provider: subject.provider, connectorId: subject.connectorId },
                }).catch((error: unknown) => {
                    // The Account service boundary carries only the existing
                    // content-free cause, never HTTP bodies or exception prose.
                    const failure = readDeploymentAuthorizationFailure(error)
                        ?? parseActionExecuteFailure(error instanceof Error ? error.cause : undefined);
                    const failureCause = failure?.failureCause
                        ?? projectActionFailureCauseV1(error, 'deployment.connector_secret_grant');
                    throw new PluginError({ code: failure?.errorCode ?? failureCause.errorCode ?? 'connector_grant_unavailable',
                        failureCause });
                });
                const grant = { machineId: target.machineId, installationId: target.installationId, grantRef: written.grantRef };
                grants.push(grant);
                onGrant?.(grant);
            }
            return { grants };
        },
    });
}

function exactConnectorRef(input: MachineConnectorSecretGrantHostRequest, grantRef: string) {
    const subject = parseMachineSecretGrantSubjectKey(grantRef);
    if (!subject || subject.kind !== 'connectorToken'
        || machineSecretGrantSubjectKey(input.subject) !== grantRef) return refuse('secret_missing');
}

export function machineConnectorSecretGrantPathForHost(machineId: string): string {
    return `/v1/deployments/machines/${encodeURIComponent(machineId)}/connector-secret-grant`;
}

async function createConnectorSecretTransportForHost(input: MachineConnectorSecretGrantHostRequest) {
    if (!input.context.operationAcceptance?.operationId) return refuse('operation_unavailable');
    const custody = createInstalledSecretTransportForHost({ ...input,
        machineId: input.hostMachineId, installationId: input.hostInstallationId }, input.createReadRequestHeaders ? async body => {
        const parsed = MachineConnectorSecretGrantInputV1Schema.parse(body);
        if (parsed.operation !== 'read') return refuse('action_forbidden');
        return await input.createReadRequestHeaders!(parsed);
    } : undefined);
    try {
        await custody.assertCurrent();
        const actionId = input.deploymentChild?.actionId ?? input.context.externalActionExecutionAuthorization?.binding.actionId;
        // Domain effects carry their accepted child to Home. Its active-job
        // lookup owns this request; local custody only observes cancellation.
        if (actionId !== 'deployments.domains.add' && actionId !== 'deployments.domains.remove') {
            await assertMachineConnectorSecretInvocationCurrent(input);
        }
        await custody.assertCurrent();
    } catch (error) { custody.release(); throw error; }
    const projectResponse = ({ response, requestHeaders }: Readonly<{
        response: Readonly<{ status: number; data: unknown }>;
        requestHeaders: Readonly<Record<string, string>>;
    }>) => {
        const parsed = MachineConnectorSecretGrantResultV1Schema.safeParse(response.data);
        if (!parsed.success && (response.status === 401 || response.status === 403)) {
            const failure = projectHomeAuthorizationHttpFailure(response.status, requestHeaders, response.data);
            return refuse(failure.errorCode, failure);
        }
        if (!parsed.success) return refuse(response.status === 404 || response.status === 405 || response.status === 501
            ? 'unsupported_action' : 'invalid_action_output');
        if (!parsed.data.ok) return refuse(parsed.data.error, {
            ok: false, errorCode: parsed.data.error, error: parsed.data.error,
            failureCause: projectActionFailureCauseV1(
                createHttpStatusError(response.status, parsed.data.error, parsed.data.error), 'deployment.connector_secret_grant'),
        });
        if (response.status !== 200) return refuse('invalid_action_output');
        const grant = parsed.data.grant;
        if (grant && (grant.kind !== 'connectorToken' || machineSecretGrantSubjectKey(grant) !== machineSecretGrantSubjectKey(input.subject))) {
            return refuse('secret_missing');
        }
        return grant;
    };
    const body = { serverId: input.serverId, hostMachineId: input.hostMachineId,
        hostInstallationId: input.hostInstallationId, subject: input.subject };
    const path = machineConnectorSecretGrantPathForHost(input.subject.machineId);
    const effectActionId = input.deploymentChild?.actionId ?? input.context.externalActionExecutionAuthorization?.binding.actionId;
    const request = async (operation: MachineConnectorSecretGrantBodyV1) => projectResponse(await custody.request(
        path, MachineConnectorSecretGrantBodyV1Schema.parse(operation), effectActionId));
    const prepareRemoval = async () => {
        const send = await custody.prepareRequest(path,
            MachineConnectorSecretGrantBodyV1Schema.parse({ ...body, operation: 'remove' }), effectActionId);
        // Exact proof and requester headers were captured while admitted. Cleanup
        // is a later natural HTTP boundary, not another local custody acquisition.
        const signal = new AbortController().signal;
        return async () => projectResponse(await send(signal));
    };
    return { ...custody, body, request, prepareRemoval };
}

/** P21 seals in its admitted controller invocation; only the canonical value-free ref leaves custody. */
export async function writeMachineConnectorSecretGrantForHost(input: MachineConnectorSecretGrantHostRequest & Readonly<{
    installationPublicKey: Uint8Array; token: Uint8Array;
}>): Promise<Readonly<{ grantRef: string }>> {
    const custody = await createConnectorSecretTransportForHost(input);
    const bytes = input.token.slice();
    try {
        await custody.assertCurrent();
        const grant = sealMachineSecretGrant({ subject: input.subject, installationPublicKey: input.installationPublicKey,
            content: { kind: 'connectorToken', token: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } });
        const stored = await custody.request({ ...custody.body, operation: 'set', grant });
        if (!stored || stored.sealedContent !== grant.sealedContent) return refuse('invalid_action_output');
        return { grantRef: machineSecretGrantSubjectKey(input.subject) };
    } finally { bytes.fill(0); custody.release(); }
}

/** One finite acquisition shared by the sealed reader and protected-file materializer. */
async function acquireMachineConnectorSecretGrantForHost(input: MachineConnectorSecretGrantHostRequest & Readonly<{ grantRef: string }>) {
    exactConnectorRef(input, input.grantRef);
    if (input.hostMachineId !== input.subject.machineId || input.hostInstallationId !== input.subject.installationId) return refuse('secret_missing');
    const custody = await createConnectorSecretTransportForHost(input);
    try {
        const grant = await custody.request({ ...custody.body, operation: 'read' });
        if (!grant) return refuse('secret_missing');
        return { grant, custody };
    } catch (error) { custody.release(); throw error; }
}

/** Exact installed delivery; withdrawal is admitted again at the next acquisition. */
export async function readMachineConnectorSecretGrantForHost(input: MachineConnectorSecretGrantHostRequest & Readonly<{ grantRef: string }>) {
    const { grant, custody } = await acquireMachineConnectorSecretGrantForHost(input);
    return { grant, assertCurrent: custody.assertCurrent, release: custody.release };
}

/** Host-private P20 protected-file boundary. Installed seeds never leave this owner. */
export async function materializeMachineConnectorSecretGrantForHost(input: MachineConnectorSecretGrantHostRequest & Readonly<{ grantRef: string }>) {
    const { grant, custody } = await acquireMachineConnectorSecretGrantForHost(input);
    const key = decodeBase64(custody.identity.privateKey, 'base64url');
    let bytes: Uint8Array | undefined;
    try {
        const content = openMachineSecretGrant({ grant, machineId: input.subject.machineId,
            installationId: input.subject.installationId, installationPrivateSeed: key.subarray(0, 32) });
        if (content?.kind !== 'connectorToken') return refuse('secret_missing');
        bytes = new TextEncoder().encode(content.token);
        await custody.assertCurrent();
        const material = bytes;
        return { bytes: material, assertCurrent: custody.assertCurrent,
            dispose() { material.fill(0); custody.release(); } };
    } catch (error) { bytes?.fill(0); custody.release(); throw error; }
    finally { key.fill(0); }
}

export async function prepareMachineConnectorSecretGrantRemovalForHost(input: MachineConnectorSecretGrantHostRequest & Readonly<{ grantRef: string }>): Promise<() => Promise<void>> {
    exactConnectorRef(input, input.grantRef);
    const custody = await createConnectorSecretTransportForHost(input);
    try {
        const remove = await custody.prepareRemoval();
        return async () => {
            try {
                if (await remove()) return refuse('invalid_action_output');
            } finally { custody.release(); }
        };
    } catch (error) { custody.release(); throw error; }
}

export async function removeMachineConnectorSecretGrantForHost(input: MachineConnectorSecretGrantHostRequest & Readonly<{ grantRef: string }>): Promise<void> {
    await (await prepareMachineConnectorSecretGrantRemovalForHost(input))();
}

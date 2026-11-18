import { ManagedMachinePresetGetResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { SessionProjectFilesV1 } from '@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1';
import type { ManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveMachineRetentionPolicyV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { managedMachineSetupHasWorkV1, prepareManagedOpaquePresetAcquireV1 } from '@happier-dev/cli-common/machines/managed';
import { createExternalActionRequesterServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { projectManagedMachineRolePurposeBindingsV1 } from '@happier-dev/cli-common/machines/managed';
import type { ConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import axios from '@/api/client/credentialAxios';
import { readHttpStatus } from '@/api/client/httpStatusError';
import { MachineProvisionerSnapshotResultV1Schema, readMachineProvisionerSessionPlacementV1, type MachineProvisionerSnapshotResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { isExternalActionManagedWakeRootV1, readExternalActionManagedRetryGuestCliV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { redactManagedMachineCredentialReferences, ManagedMachineFullV1Schema, ManagedMachineV1Schema,
    isManagedOpaquePresetMachineV1, type ManagedControllerV1, type ManagedMachineFullV1,
    type ManagedMachineV1, type ManagedMachineReadSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { isDeepStrictEqual } from 'node:util';
import type { ActionExecuteResult, ActionExecutorContext, JsonValue, ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol';
import { ManagedPendingActivationFailureRequestV1Schema, PendingActivationFailureResponseV1Schema } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { executeManagedProvisionerDiscovery, qualifyManagedOpaquePresetProvisionerV1,
    readManagedOpaquePresetProvisionerV1, type ManagedProvisionerDiscoveryEntry } from '@happier-dev/cli-common/machines/managed/provisioners';
import { ManagedAcquireInputV1Schema, ManagedAdmissionOutputV1Schema, ManagedControllerCurrentnessV1Schema, ManagedControllerMachineOutputV1Schema, ManagedControllerSubmitOutputV1Schema, ManagedControllerContextOutputV1Schema, ManagedErrorV1Schema, ManagedGetOutputV1Schema, ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1, managedMachineActionEndpointPathV1, unwrapManagedMachineReadV1, type ManagedAcceptedV1, type ManagedAcquireInputV1, type ManagedAdmissionOutputV1, type ManagedControllerCurrentnessV1, type ManagedMachineActionIdV1, type ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedAdmissionInputV1Schema, isManagedPresetAcquireInputV1, ManagedControlAdmissionInputV1Schema, MANAGED_CONTROL_ACTION_IDS_V1, resolveManagedAcquireReviewV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { MANAGED_RESIZE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { ManagedResizeOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { executeManagedMachineResize } from '@happier-dev/cli-common/machines/managed';
import { ManagedControllerRequestFailureDetailsV1Schema, type ManagedControllerRequestFailureDetailsV1 } from '@happier-dev/protocol/actions/operations/v1';
import { projectActionFailureCauseV1, projectUnexpectedActionFailureV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MANAGED_POLICY_PROOF_HEADER, createManagedPolicyProofV1, encodeManagedPolicyProofV1,
    ManagedPolicyAdmissionInputV1Schema, ManagedPolicyAdmissionOutputV1Schema, type ManagedPolicyPurposeV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveExternalActionServerRequestHeaders, type ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import type { ManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { StoredCredentials } from '@/persistence';
import { retryHomeOperation, isRetryableHomeOperationError, REMOTE_HOME_ENROLLMENT_POLL_INTERVAL_MS, type HomeOperationRetry } from '@/api/client/retryHomeOperation';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { ManagedBootstrapCarrierV1Schema, type AcquireResultV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { captureManagedPendingNativeIdentity, captureManagedSubmittedNativeIdentity, readManagedIssuedNativeFact,
    type CapturedManagedNativeIdentity } from '@happier-dev/cli-common/machines/managed/reconcile';
import { createManagedNativeInvocation, reconcileManagedMachine, resolveManagedRoleCredentialAuthorizations, resolveManagedRoleRuntime } from './reconcile';
import { composeManagedNativeCredentials, applyManagedNativeCredentialPolicy } from './nativeCredentialComposer';
import { ManagedControllerCredentialDeliveryReportOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { reconcileManagedIntent, prepareManagedRetentionPolicy, type ManagedGuestActivityTransport } from './managedIntentReconciler';
import { logger } from '@/ui/logger';
import { readManagedGuestHomeWarning } from './homeQualification';
import type { RecordedApprovalExecutionObservationArgs } from '@/session/actions/createCliActionExecutorHarness';
import type { RuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { executeManagedMachineAcquire, readManagedGuestDiagnostics, createManagedNativeBootstrapIO, ensureManagedGuestSessionHolder, probeManagedNativeGuestPlatform,
    type ManagedGuestPlatform, type SessionHolderArtifact } from '@happier-dev/cli-common/machines/managed';
import { openManagedNativeChannel } from '@happier-dev/cli-common/machines/managed/nativeChannel';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { readManagedGuestCliIdentity, resolveRemoteInstalledFirstPartyBinaryPath } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { readManagedGuestCliLocalPayloadRoot } from '@happier-dev/cli-common/systemTasks/kinds/remoteFirstPartyPayloadInstaller';
import { runBoundSessionSetup } from './boundSessionSetup';
import type { ManagedGuestLocalStop } from './managedRetentionPolicy';
import { MachineProvisionerRenewResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { createManagedNativeObservationWait } from './nativeObservationWait';
import { prepareManagedSessionSshTrust } from './enrollmentSshTrust';
import { createManagedSshSessionTransport } from './sessionSshTransport';
import { projectContributedActionFailure } from '@/plugins/runtime/invocation/actions/contributedActionFailure';
import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import { installManagedNativePayload } from './enrollmentPayload';
import { SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { MachineSetupReportInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

import { ManagedMachineControllerError, ManagedMachineNativeRefusal, ManagedMachineNativeObservationFailure, isUncertainManagedControllerRequest } from './controllerErrors';
import { createManagedPresetHydrator, openManagedPresetCarrier, withManagedOpaquePresetReview,
    type ManagedPresetDefinitionOpener, type ManagedPresetHydrator } from './presetHydration';
export { ManagedMachineControllerError, ManagedMachineNativeRefusal, ManagedMachineNativeEffectGuardRefusal } from './controllerErrors';

export type ManagedMachineAcquisitionDriverInput = Readonly<{
    token: string;
    serverUrl: string;
    homeId: string;
    controller: ManagedControllerV1;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
    credentials: StoredCredentials;
    managedProviderOperationAuthority: ManagedProviderOperationAuthority;
    /** The native controller borrows the canonical Account host for portable roles. */
    resolveAccountRuntime?: () => Promise<Pick<ManagedMachineAcquisitionDriverInput,
        'runtimeRegistry' | 'managedProviderOperationAuthority' | 'readCredentialConfigurationRevision'>>;
    /** Current configuration metadata from the existing Account purpose owner. */
    readCredentialConfigurationRevision?: ConnectedAccountPurposeBindingOwner['readCredentialConfigurationRevision'];
    homeTarget: ResolvedHomeTarget;
    readGuestHomeHostIdentity?: (homeId: string) => Promise<import('@happier-dev/protocol/plugins/contributions/machineProvisioners').MachineProvisionerGuestHomeV1['hostIdentity']>;
    externalActionMachineRequestPrivateKey?: ExternalActionMachineRequestSigningKey;
    observeRecordedApprovalExecution?: (args: RecordedApprovalExecutionObservationArgs) => Promise<ActionExecuteResult>;
    managedGuestActivity?: ManagedGuestActivityTransport;
    managedGuestLocalStop?: ManagedGuestLocalStop;
    /** Classified changes from the controller's existing Account-feed owner. */
    subscribeManagedMachineChanges?: import('@/api/apiMachine').ApiMachineClient['onManagedMachinePolicyInvalidated'];
    readPolicyCurrent?: (managedId: string, signal?: AbortSignal) => Promise<ManagedMachineV1 | null>;
    /** HTTP boundary shared by Home CLI identity and public release discovery. */
    guestCliFetch?: typeof fetch;
    /** Join the installed host's existing finite Prepare operation, including cleanup. */
    waitForActionOperationCompletion?: import('@/api/apiMachine').ApiMachineClient['waitForActionOperationCompletion'];
    prepareTeamCredentialNativeSource?: RuntimeProviderModelManagementServices['prepareTeamCredentialNativeSource'];
}>;

type OpaqueManagedAdmission = Extract<ManagedAdmissionOutputV1, { presetContent: unknown }>;

function isOpaqueManagedAdmission(admission: ManagedAdmissionOutputV1): admission is OpaqueManagedAdmission {
    return 'presetContent' in admission;
}

const normalizeManagedPresetCarrier = openManagedPresetCarrier;

async function qualifyManagedPresetAcquire(input: ManagedMachineAcquisitionDriverInput,
    machine: Pick<ManagedMachineFullV1, 'launch'>): Promise<MachineProvisionerContributionV1> {
    const candidates = (registry: ResolvedExecutablePluginRuntimeRegistry) => registry.contributes.machineProvisioners?.map(candidate => ({
        contribution: candidate.identity, descriptor: candidate.definition,
    })) ?? [];
    const declared = readManagedOpaquePresetProvisionerV1({ launch: machine.launch, provisioners: candidates(input.runtimeRegistry) });
    if (!declared?.actions.acquire) throw new ManagedMachineControllerError('provider_unavailable');
    const roleHost = await resolveManagedRoleRuntime(input, machine.launch.provider.pluginId, declared.actions.acquire);
    const provider = qualifyManagedOpaquePresetProvisionerV1({ launch: machine.launch, provisioners: candidates(roleHost.runtimeRegistry) });
    if (!provider?.actions.acquire) throw new ManagedMachineControllerError('provider_unavailable');
    await resolveManagedRoleCredentialAuthorizations(roleHost, machine.launch.provider, provider.actions.acquire,
        machine.launch.credentials, { descriptor: provider, launch: machine.launch.choices });
    return provider;
}

async function withManagedPresetPolicy(input: ManagedMachineAcquisitionDriverInput,
    acquisition: Extract<ManagedAcquireInputV1, { selection: { kind: 'preset' } }>,
    hydrator: ManagedPresetHydrator, delegated: boolean, accept: (policy: Omit<ReturnType<typeof resolveMachineRetentionPolicyV1>, 'category'>,
        provisioner: MachineProvisionerContributionV1, open: ManagedPresetDefinitionOpener) => Promise<ManagedMachineFullV1>, signal?: AbortSignal,
    localPlacement?: Pick<ManagedMachineExecutionOptions, 'expectedProvisioner' | 'onLocalSessionPlacement'>,
    admittedRoot?: ExternalActionExecutionAuthorizationV1['binding']) {
    const scoped = admittedRoot?.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 ? admittedRoot.sessionPresetAcquisition : undefined;
    const snapshot = scoped?.admission;
    if (scoped?.admission && (!isDeepStrictEqual(scoped.selection, acquisition.selection)
        || !isDeepStrictEqual(scoped.controller, acquisition.controller))) throw new ManagedMachineControllerError('request_conflict');
    const preset = snapshot ? { ...snapshot.preset, ...snapshot.presetContent } : await (async () => {
        const response = await axios.post<unknown>(`${input.serverUrl.replace(/\/+$/, '')}/v1/machines/presets/get`,
            { homeId: acquisition.selection.homeId, id: acquisition.selection.id },
            { headers: { Authorization: `Bearer ${input.credentials.token}` }, ...(signal ? { signal } : {}) });
        const read = ManagedMachinePresetGetResultV1Schema.parse(response.data);
        if (read.kind === 'refused') throw new ManagedMachineControllerError(read.code);
        return read.preset;
    })();
    if (preset.revision !== acquisition.selection.revision) throw new ManagedMachineControllerError('request_conflict');
    return await hydrator.withPresetDefinition(preset, async (opened, open) => {
        if (!opened.launch) throw new ManagedMachineControllerError('credential_unavailable');
        const provisioner = await qualifyManagedPresetAcquire(input, { launch: opened.launch });
        if (localPlacement) {
            const expected = localPlacement.expectedProvisioner;
            if (expected && (expected.pluginId !== opened.launch.provider.pluginId || expected.localId !== opened.launch.provider.localId)) {
                throw new ManagedMachineControllerError('invalid_request');
            }
            const placement = readMachineProvisionerSessionPlacementV1(provisioner, opened.launch.choices);
            if (placement?.kind !== 'controller-local') throw new ManagedMachineControllerError('provider_unavailable');
            localPlacement.onLocalSessionPlacement?.(placement, opened.projectFiles);
        }
        const prepared = await prepareManagedOpaquePresetAcquireV1({ content: preset.content,
            override: acquisition.presetContentOverride, provisioner, open });
        if (!prepared) throw new ManagedMachineControllerError('credential_unavailable');
        const { category: _category, ...policy } = resolveMachineRetentionPolicyV1({ billing: provisioner.billing,
            nativeCapabilities: provisioner.retention, presetOverride: preset,
            ...((snapshot?.delegated ?? delegated) ? {} : { machineOverride: { retention: acquisition.retention,
                wakeOnAcceptedMessage: acquisition.wakeOnAcceptedMessage } }) });
        return await accept(policy, provisioner, open);
    }, signal);
}

async function openManagedPresetAdmissionWithHydrator(params: Readonly<{
    input: ManagedMachineAcquisitionDriverInput;
    acquisition: ManagedAcquireInputV1;
    admission: ManagedAdmissionOutputV1;
    hydrator: ManagedPresetHydrator;
    signal?: AbortSignal;
    preparation?: Readonly<{ provisioner: MachineProvisionerContributionV1; open: ManagedPresetDefinitionOpener }>;
}>): Promise<ManagedMachineFullV1> {
    const selection = params.acquisition.selection;
    if (selection.kind !== 'preset') {
        if (isOpaqueManagedAdmission(params.admission)) throw new ManagedMachineControllerError('request_conflict');
        return ManagedMachineFullV1Schema.parse(params.admission.machine);
    }
    if (!isOpaqueManagedAdmission(params.admission) || params.admission.machine.preset.id !== selection.id
        || params.admission.machine.preset.revision !== selection.revision) {
        throw new ManagedMachineControllerError('request_conflict');
    }
    const admission = params.admission;
    const preparation = params.preparation;
    const heldOpen = preparation ? (content: Parameters<ManagedPresetDefinitionOpener>[0]) =>
        preparation.open(content, admission.presetContent.recipients) : undefined;
    const opened = await params.hydrator.openSnapshot(params.admission.machine, params.admission.presetContent, params.signal, heldOpen);
    if (!opened.launch) throw new ManagedMachineControllerError('credential_unavailable');
    const provisioner = params.preparation?.provisioner ?? await qualifyManagedPresetAcquire(params.input, { launch: opened.launch });
    return await params.hydrator.prepareAdmissionAcquire(params.admission.machine, params.admission.presetContentOverride,
        provisioner, params.signal, heldOpen);
}

/** Opens and qualifies the private preset snapshot at its installed custodian. */
export async function openManagedPresetAdmission(params: Readonly<{
    input: ManagedMachineAcquisitionDriverInput;
    acquisition: ManagedAcquireInputV1;
    admission: ManagedAdmissionOutputV1;
    signal?: AbortSignal;
}>): Promise<ManagedMachineFullV1> {
    const hydrator = createManagedPresetHydrator(params.input);
    return await openManagedPresetAdmissionWithHydrator({ ...params, hydrator });
}
export type ManagedMachineExecutionOptions = Readonly<{
    requestId: string;
    /** Receiving-daemon placement stops at native resource binding. */
    acquisitionMode?: 'enrolled' | 'resource-bound';
    /** Local shared policy may choose an idle kept guest at admission. */
    reuseIdle?: true;
    /** The receiving policy pins the provisioner behind its configured preset. */
    expectedProvisioner?: Readonly<{ pluginId: string; localId: string }>;
    onLocalSessionPlacement?: (placement: NonNullable<MachineProvisionerContributionV1['sessionPlacement']>, projectFiles?: SessionProjectFilesV1) => void;
    context?: ActionExecutorContext;
    signal?: AbortSignal;
    /** Scheduler retirement is separate from the independently admitted pending input. */
    policySchedulerSignal?: AbortSignal;
    policyPurpose?: ManagedPolicyPurposeV1;
    policyMachine?: ManagedMachineReadSnapshotV1;
    /** Exact pending request projected from Home's current retention admission. */
    retentionContinuationRequestId?: string;
    /** Original admitted finite request; distinct from the controller's native policy authority. */
    actionOrigin?: ExternalActionExecutionAuthorizationV1;
    /** The installed Action owner evaluates current policy/Ask at effect time. */
    runPolicyAction?: (machine: ManagedMachineFullV1, runApproved: (context: ActionExecutorContext) => Promise<ManagedMachineFullV1>) => Promise<ManagedMachineFullV1>;
    /** Ordinary fresh Session admission retained only by its initiating host. */
    runAgentStart?: (input: Readonly<{ machine: ManagedMachineFullV1; projectFiles?: SessionProjectFilesV1 }>) => Promise<void>;
    /** Original admitted Workflow continuation on its ordinary enrolled Machine. */
    runCreationContinuation?: (input: Readonly<{ machine: ManagedMachineFullV1; projectFiles?: SessionProjectFilesV1 }>) => Promise<void>;
    runEnvironmentSetup?: (input: Readonly<{ machine: ManagedMachineFullV1; isCurrent(): Promise<boolean> }>) => Promise<ManagedMachineV1>;
    /** Content-free installed Account socket; every wake re-reads the signed row. */
    subscribeEnvironmentSetupChanges?: (callbacks: Readonly<{ onChange(): void; onError(error: unknown): void }>) => Promise<{ dispose(): void | Promise<void> }>;
}>;

/** The controller transport consumes the server's row/currentness authority. */
export function createManagedMachineControllerClient(input: ManagedMachineAcquisitionDriverInput, options: ManagedMachineExecutionOptions,
    action: ManagedMachineActionIdV1, hydrator: ManagedPresetHydrator = createManagedPresetHydrator(input)) {
    let policyMachine = options.policyMachine;
    let homeRetry: HomeOperationRetry | undefined;
    let submittedIdentity: CapturedManagedNativeIdentity | undefined;
    function assertConnection(machine: Pick<ManagedMachineV1, 'homeId' | 'controller'>): void {
        if (machine.homeId !== input.homeId || machine.controller && (machine.controller.machineId !== input.controller.machineId
            || machine.controller.installationId !== input.controller.installationId)) throw new ManagedMachineControllerError('controller_unavailable');
    }
    function originProjection() {
        const authorization = options.context?.externalActionExecutionAuthorization;
        if (!authorization || !authorization.binding.sessionActionOrigin && !authorization.binding.workflowActionOrigin) return null;
        const projection = authorization.requesterHttpProjection;
        if (!projection || projection.accountId !== authorization.binding.accountId || projection.serverIdentityId !== input.homeId
            || authorization.binding.installationId !== input.controller.installationId
            || (projection.accountEncryptionMode !== undefined && projection.accountEncryptionMode !== authorization.binding.accountEncryptionMode)) {
            throw new ManagedMachineControllerError('admission_unavailable');
        }
        return projection;
    }
    async function isOriginCurrent(): Promise<boolean> {
        const projection = originProjection();
        return !projection || await projection.isCurrent();
    }
    function readManagedId(body: unknown): string | undefined {
        return body && typeof body === 'object' && 'managedId' in body && typeof body.managedId === 'string'
            ? body.managedId : undefined;
    }
    function requestFailure(path: string, category: ManagedControllerRequestFailureDetailsV1['category'], status?: number, failureCode?: string, managedId?: string) {
        const base = { kind: 'managedControllerRequest' as const, path, category, ...(status === undefined ? {} : { status }) };
        const withCode = ManagedControllerRequestFailureDetailsV1Schema.safeParse({ ...base, code: failureCode });
        const details = withCode.success ? withCode.data : ManagedControllerRequestFailureDetailsV1Schema.parse(base);
        const operationId = options.context?.operationAcceptance?.operationId;
        logger.warn('[MANAGED MACHINE] Controller request failed', {
            managedId: managedId ?? null,
            ...(operationId ? { operationId } : {}),
            path: details.path,
            category: details.category,
            httpStatus: details.status ?? null,
            code: details.code ?? null,
            requestId: options.requestId,
        });
        const error = new ManagedMachineControllerError(details.code ?? 'managed_controller_request_failed', status, details);
        return new ManagedMachineControllerError(error.code, status, details,
            projectActionFailureCauseV1(error, `managed.controller.${path.slice(path.lastIndexOf('/') + 1).replaceAll('-', '_')}`));
    }
    async function request<T>(path: string, body: unknown, headers: Readonly<Record<string, string>>, schema: { parse(data: unknown): T }, signal?: AbortSignal | null): Promise<T> {
        const run = () => requestOnce(path, body, headers, schema, signal);
        try { return await run(); }
        catch (error) {
            const result = body && typeof body === 'object' && 'result' in body ? body.result : null;
            // Preserve the first factual report even after cancellation. Once
            // Home is unavailable, redelivery of this repeatable fact belongs to
            // the admitted operation lifetime, without replaying native work or
            // a credential claim. Connection unavailability need not prove rollback.
            if (path !== '/v1/machines/managed/controller/report'
                || !body || typeof body !== 'object' || 'credentialDelivery' in body
                || !result || typeof result !== 'object' || !('kind' in result) || result.kind !== 'bound'
                || !options.signal || options.signal.aborted
                || !(error instanceof ManagedMachineControllerError) || error.status !== 503
                || (error.code !== 'database_transaction_timeout' && error.code !== 'database_connection_unavailable')) throw error;
            return await retryHomeOperation({ signal: options.signal,
                pollIntervalMs: REMOTE_HOME_ENROLLMENT_POLL_INTERVAL_MS },
                () => requestOnce(path, body, headers, schema, options.signal));
        }
    }
    async function requestOnce<T>(path: string, body: unknown, headers: Readonly<Record<string, string>>, schema: { parse(data: unknown): T }, signal?: AbortSignal | null): Promise<T> {
        const managedId = readManagedId(body);
        const response = await axios.post<unknown>(`${input.serverUrl.replace(/\/+$/, '')}${path}`, body, {
            headers: { ...headers, 'Content-Type': 'application/json' },
            signal: signal ?? undefined, validateStatus: () => true,
        }).catch((error: unknown) => {
            // Rejected HTTP responses use the same code/status parser; transport
            // failures retain their machine-readable code without request details.
            if (axios.isAxiosError<unknown>(error) && error.response) return error.response;
            // The credential client refuses some statuses (e.g. 431) as a coded status error without an Axios response.
            const refusedStatus = readHttpStatus(error);
            if (refusedStatus !== null) throw requestFailure(path, 'status', refusedStatus,
                error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined, managedId);
            throw requestFailure(path, 'transport', undefined, axios.isAxiosError(error) ? error.code : undefined, managedId);
        });
        if (response.status < 200 || response.status >= 300) {
            const failure = ManagedErrorV1Schema.safeParse(response.data);
            // Global Home/Fastify refusals can carry code plus diagnostic fields,
            // outside the managed domain enum. Retain only the code and HTTP status.
            const data: unknown = response.data;
            const serverCode = data && typeof data === 'object' ? [
                'code' in data ? data.code : undefined,
                'error' in data ? data.error : undefined,
            ].find((value): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]*$/i.test(value)) : undefined;
            throw requestFailure(path, 'status', response.status, failure.success ? failure.data.code : serverCode, managedId);
        }
        try { return schema.parse(response.data); }
        catch { throw requestFailure(path, 'schema', response.status, undefined, managedId); }
    }
    async function post<T>(path: string, body: unknown, schema: { parse(data: unknown): T }, signal: AbortSignal | null | undefined = options.signal,
        effectOverride?: typeof SESSION_SPAWN_NEW_ACTION_ID_V1): Promise<T> {
        const prepared = path === '/v1/machines/managed/controller/report'
            ? await hydrator.prepareControllerReport('report', body, signal ?? undefined)
            : path === '/v1/machines/managed/controller/report-intent'
                ? await hydrator.prepareControllerReport('report-intent', body, signal ?? undefined)
                : body;
        const run = () => postOnce(path, prepared, schema, signal, effectOverride);
        // Only the repeatable authority observation is replayed. Every retry
        // obtains fresh request authorization; submit/report/native effects do not replay.
        return path === '/v1/machines/managed/controller/current' && homeRetry
            ? await retryHomeOperation({ ...homeRetry, signal: signal ?? homeRetry.signal }, run) : await run();
    }
    async function postOnce<T>(path: string, body: unknown, schema: { parse(data: unknown): T }, signal: AbortSignal | null | undefined,
        effectOverride?: typeof SESSION_SPAWN_NEW_ACTION_ID_V1): Promise<T> {
        try {
            // A preparatory row read belongs to the admitted root. Home checks
            // that root's exact managed row; `get` is not a second Action grant.
            const effectActionId = effectOverride ?? (action === 'machines.managed.get' && path === '/v1/machines/managed/actions/get'
                ? options.context?.externalActionExecutionAuthorization?.binding.actionId ?? action : action);
            const projection = originProjection();
            if (projection && !(action === MANAGED_RESIZE_ACTION_ID_V1 && path === '/v1/machines/managed/controller/report-resize'
                || options.context?.externalActionExecutionAuthorization?.binding.workflowActionOrigin
                    && path === '/v1/machines/managed/controller/report-intent')) {
                const headers = await projection.createRequestHeaders({ effectActionId, method: 'POST', path, body, signal: signal ?? undefined });
                if (!headers) throw new ManagedMachineControllerError('admission_unavailable');
                return await request(path, body, headers, schema, signal);
            }
            const authorization = options.policyPurpose ? (() => {
                if (!policyMachine || (!policyMachine.resource && !(options.policyPurpose?.kind === 'creation-cleanup' && policyMachine.nativeOperationRef))
                    || !input.externalActionMachineRequestPrivateKey
                    || options.context?.externalActionCredential || options.context?.externalActionExecutionAuthorization) {
                    return { ok: false as const };
                }
                assertConnection(policyMachine);
                return { ok: true as const, headers: { Authorization: `Bearer ${input.token}`,
                    [MANAGED_POLICY_PROOF_HEADER]: encodeManagedPolicyProofV1(createManagedPolicyProofV1({
                        correlation: correlation(policyMachine), purpose: options.policyPurpose,
                        ...(policyMachine.resource ? { resource: policyMachine.resource } : { nativeOperation: policyMachine.nativeOperationRef! }),
                        custodianAccountId: policyMachine.custodianAccountId, path, body, privateKey: input.externalActionMachineRequestPrivateKey,
                        ...(options.actionOrigin ? { actionOrigin: options.actionOrigin } : {}),
                    })),
                } };
            })() : resolveExternalActionServerRequestHeaders({
                context: options.context, effectActionId, method: 'POST', path, body,
                daemonToken: input.token, serverIdentityId: input.homeId,
                privateKey: input.externalActionMachineRequestPrivateKey,
                installationId: input.controller.installationId,
            });
            if (!authorization.ok) throw new ManagedMachineControllerError('admission_unavailable');
            return await request(path, body, authorization.headers, schema, signal);
        } catch (error) {
            if (error instanceof ManagedMachineControllerError) throw error;
            throw requestFailure(path, 'currentness', undefined, undefined, readManagedId(body));
        }
    }
    function correlation(machine: Pick<ManagedMachineV1, 'id' | 'intentRevision'>): ManagedControllerCurrentnessV1 & Readonly<{ controller: ManagedControllerV1 }> {
        const current = ManagedControllerCurrentnessV1Schema.parse({
            homeId: input.homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision,
            requestId: options.requestId, controller: input.controller,
        });
        return { ...current, controller: input.controller };
    }
    async function row(path: string, body: unknown, signal?: AbortSignal | null): Promise<ManagedMachineFullV1> {
        const machine = hydrator.normalize((await post(`/v1/machines/managed/controller/${path}`, body, ManagedControllerMachineOutputV1Schema, signal)).machine);
        if (options.policyPurpose) policyMachine = machine;
        return machine;
    }
    async function readCurrent(machine: ManagedMachineFullV1, nativeRole?: 'inspect'): Promise<ManagedMachineFullV1 | null> {
        if (options.signal?.aborted) return null;
        try {
            const current = await row('current', { ...correlation(machine), ...(nativeRole ? { nativeRole } : {}) });
            if (!await isOriginCurrent()) return null;
            const verified = current.id === machine.id && current.homeId === input.homeId
                && current.intentRevision === machine.intentRevision
                && pluginJsonValuesEqual(current.launch, machine.launch)
                && (action === 'machines.managed.inspect' || current.creationState === 'active'
                    || (action === 'machines.managed.delete'
                        && current.creationState === 'canceled' && current.desired === 'delete' && current.desiredWhen === 'now'
                        && current.archivedAt === undefined && (current.allocation === 'bound' && Boolean(current.resource)
                            || current.allocation === 'may-exist' && Boolean(current.nativeOperationRef))))
                && (!machine.resource || isDeepStrictEqual(current.resource, machine.resource))
                && (machine.resource || !machine.nativeOperationRef || (!current.resource
                    && current.allocation === machine.allocation && pluginJsonValuesEqual(current.nativeOperationRef, machine.nativeOperationRef)))
                && (!current.controller || current.controller.machineId === input.controller.machineId
                    && current.controller.installationId === input.controller.installationId);
            return verified ? current : null;
        } catch (error) {
            if (options.signal?.aborted) return null;
            // An unreadable authority is not evidence that the admitted row changed.
            // Preserve safe Home refusals, never transport diagnostics or request data.
            throw error instanceof ManagedMachineControllerError ? error
                : requestFailure('/v1/machines/managed/controller/current', 'currentness', undefined, undefined, machine.id);
        }
    }
    async function isCurrent(machine: ManagedMachineFullV1, nativeRole?: 'inspect'): Promise<boolean> {
        // Passive lifetime queries fail closed. Effect admission uses the strict
        // read so an unreadable source retains its typed refusal.
        try { return await readCurrent(machine, nativeRole) !== null; }
        catch (error) {
            // During an admitted enrollment, unavailable authority must reach
            // its effect owner, rather than becoming a definite intent change.
            if (homeRetry && isRetryableHomeOperationError(error)) throw error;
            return false;
        }
    }
    // Opaque rows are structural at Home; every claimed effect continues from the locally opened row.
    async function submitIdentity(machine: ManagedMachineFullV1, kind: 'acquire' | 'rebuild' | 'intent', presetContent?: import('@happier-dev/protocol/machines/managed/actionsV1').ManagedControllerPresetContentV1) {
        const provider = input.runtimeRegistry.contributes.machineProvisioners?.find(candidate =>
            candidate.identity.pluginId === machine.launch.provider.pluginId && candidate.identity.localId === machine.launch.provider.localId
            && candidate.definition.schemaVersion === machine.launch.schemaVersion);
        const path = kind === 'acquire' ? 'submit' : 'submit-intent';
        const response = await post(`/v1/machines/managed/controller/${path}`, { ...correlation(machine),
            ...(presetContent === undefined ? {} : { presetContent }) }, ManagedControllerSubmitOutputV1Schema);
        const submitted = { ...response, machine: hydrator.normalize(response.machine) };
        if (kind !== 'intent' && submitted.submitted && provider) submittedIdentity = captureManagedSubmittedNativeIdentity({ kind,
            machine: hydrator.structural(submitted.machine), privateMachine: submitted.machine, provisioner: provider.definition });
        return submitted;
    }
    async function reportIssuedNativeFact(machine: ManagedMachineFullV1, fact: Extract<AcquireResultV1, { kind: 'bound' | 'pending' }>, kind: CapturedManagedNativeIdentity['kind'], identity = submittedIdentity, configurationFacts?: ManagedMachineFullV1['reviewedFacts']): Promise<ManagedMachineFullV1> {
            const { result, captured } = readManagedIssuedNativeFact({ machine: hydrator.structural(machine), privateMachine: machine,
                fact, action, kind, captured: identity, correlation });
            assertConnection(captured.machine);
            const reportPath = kind === 'rebuild' ? 'report-intent' : 'report';
            // A restart opens the daemon-stored admitted snapshot, whose sealed
            // review remains the exact acquisition basis. Never ask Home to
            // reconstruct or receive that private review a second time.
            const opaquePreset = hydrator.isOpaque(machine);
            const reviewedFacts = configurationFacts ?? (opaquePreset ? hydrator.readReviewedFacts(machine) : undefined);
            if (reviewedFacts && !opaquePreset) hydrator.rememberReviewedFacts(machine, reviewedFacts);
            const body = { ...correlation(captured.machine), result,
                ...(reviewedFacts === undefined ? {} : { configurationFacts: reviewedFacts }) };
            if (!originProjection()) return await row(reportPath, body, null);
            const authorization = options.context?.externalActionExecutionAuthorization;
            const target = options.context?.externalActionTarget;
            if (!authorization || !target || !input.externalActionMachineRequestPrivateKey
                || authorization.binding.actionId !== action || authorization.binding.serverIdentityId !== input.homeId
                || authorization.binding.machineId !== input.controller.machineId
                || authorization.binding.installationId !== input.controller.installationId
                || authorization.binding.custodianAccountId !== captured.machine.custodianAccountId) {
                throw new ManagedMachineControllerError('admission_unavailable');
            }
            // The factual report ingress checks the original Home proof's
            // Account/mode/epoch and installation with the submitted
            // tuple. A generic origin-lifetime probe would incorrectly erase
            // this already-issued identity when new-effect authority retires.
            const path = `/v1/machines/managed/controller/${reportPath}`;
            const prepared = reportPath === 'report'
                ? await hydrator.prepareControllerReport('report', body)
                : await hydrator.prepareControllerReport('report-intent', body);
            let headers: ReturnType<typeof resolveExternalActionServerRequestHeaders>;
            try {
                headers = resolveExternalActionServerRequestHeaders({ context: options.context, effectActionId: action,
                    method: 'POST', path, body: prepared, daemonToken: input.token, serverIdentityId: input.homeId,
                    privateKey: input.externalActionMachineRequestPrivateKey, installationId: input.controller.installationId });
            } catch { throw requestFailure(path, 'currentness', undefined, undefined, captured.machine.id); }
            if (!headers.ok) throw new ManagedMachineControllerError('admission_unavailable');
            return hydrator.normalize((await request(path, prepared, headers.headers, ManagedControllerMachineOutputV1Schema, null)).machine);
    }
    return {
        post, row, correlation, projectEnrollmentCorrelation: hydrator.projectEnrollmentCorrelation, readCurrent, isCurrent, isOriginCurrent, assertConnection,
        async reportBoundSessionSetup(machine: ManagedMachineFullV1, report: Extract<MachineSetupReportInputV1, { target: unknown }>): Promise<ManagedMachineFullV1> {
            const prepared = await hydrator.prepareBoundSetupReport(machine, report, options.signal);
            const result = await postOnce('/v1/machines/setup/report', prepared, ManagedControllerMachineOutputV1Schema,
                options.signal, SESSION_SPAWN_NEW_ACTION_ID_V1);
            return hydrator.normalize(result.machine);
        },
        setHomeOperationRetry(lifetime?: HomeOperationRetry) { homeRetry = lifetime; },
        async submit(machine: ManagedMachineFullV1, presetContent?: import('@happier-dev/protocol/machines/managed/actionsV1').ManagedControllerPresetContentV1) { return await submitIdentity(machine, 'acquire', presetContent); },
        async submitIntent(machine: ManagedMachineFullV1) { return await submitIdentity(machine, machine.desired === 'rebuild' ? 'rebuild' : 'intent'); },
        /** Capture the admitted paid handle immediately before its safe native reconciliation. */
        async preparePendingAcquireBoundReport(machine: ManagedMachineFullV1) {
            if (action !== 'machines.managed.acquire' && action !== 'machines.managed.bootstrap.retry') {
                throw new ManagedMachineControllerError('admission_unavailable');
            }
            const current = await readCurrent(machine);
            if (!current) throw new ManagedMachineControllerError('intent_changed');
            assertConnection(current);
            const provider = input.runtimeRegistry.contributes.machineProvisioners?.find(candidate =>
                candidate.identity.pluginId === current.launch.provider.pluginId && candidate.identity.localId === current.launch.provider.localId
                && candidate.definition.schemaVersion === current.launch.schemaVersion);
            const captured = captureManagedPendingNativeIdentity({ machine: hydrator.structural(machine), privateMachine: machine,
                current: hydrator.structural(current), privateCurrent: current, provisioner: provider?.definition });
            return async (bound: Extract<AcquireResultV1, { kind: 'bound' }>) => await reportIssuedNativeFact(machine, bound, 'pending-acquire', captured);
        },
        /** Only a captured, actually issued native result can retain public identity after origin withdrawal. */
        async reportIssuedAcquireFact(machine: ManagedMachineFullV1, fact: Extract<AcquireResultV1, { kind: 'bound' | 'pending' }>, configurationFacts?: ManagedMachineFullV1['reviewedFacts']) {
            return await reportIssuedNativeFact(machine, fact, 'acquire', submittedIdentity, configurationFacts);
        },
        async reportIssuedRebuildBound(machine: ManagedMachineFullV1, bound: Extract<AcquireResultV1, { kind: 'bound' }>) {
            return await reportIssuedNativeFact(machine, bound, 'rebuild');
        },
    };
}
export type ManagedMachineControllerClient = ReturnType<typeof createManagedMachineControllerClient>;

export type ManagedNativeSnapshotRequest = Readonly<{
    machine: ManagedMachineFullV1;
    label: string;
    reason: string;
    options: ManagedMachineExecutionOptions;
}>;

/** A Session the existing spawn admission placed on a managed target this controller holds. */
export type ManagedSessionTargetRequest = Readonly<{
    managedId: string;
    /** Holder custody key; it may be a spawn nonce rather than a persisted Session id. */
    sessionId: string;
    /** Authoritative Home birth association, supplied after Session commitment. */
    committedSessionId?: string;
    /** The admitted requester; a resource-bound creator uses its Home-committed Session association. */
    requesterAccountId: string;
    /** The tracked Session's lifetime: it ends the authority, the channels and the target's holder custody. */
    lifetime: AbortSignal;
    /** Finite launch preparation only; held-Agent recovery omits it. */
    operation?: ProjectSetupOperationContext;
    holder: Readonly<{ version: string; resolveArtifacts(platform: ManagedGuestPlatform): Promise<Readonly<{ holder: SessionHolderArtifact; helper: SessionHolderArtifact }>> }>;
}>;

/** The target's provider operations for one Session, under the Session authority, plus where its holder lives. */
export type ManagedSessionTarget = Readonly<{
    id: string;
    /** Ends with the Session or when the managed target revokes this admission. */
    lifetime: AbortSignal;
    holderPath: string;
    helperPath: string;
    socketDirectory: string;
    /** The guest's platform and home (from the shared platform probe). */
    platform: ManagedGuestPlatform;
    home: string;
    /** Agent environment admitted by the target owner, independent of the host environment. */
    agentEnvironment?: Readonly<Record<string, string>>;
    exec(command: string, signal: AbortSignal): Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
    putFile(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
    openChannel(argv: readonly string[], signal: AbortSignal): import('node:stream').Duplex;
    /** The existing credential-free CLI installation, without Machine enrollment. */
    ensureWorkspaceRuntime(): Promise<Readonly<{ binaryPath: string }>>;
}>;

/** The Account graph owner admits the existing relationship before opening or reconnecting it. */
export type ManagedWorkspaceSyncTargetRequest = Readonly<{
    managedId: string;
    relationshipId: string;
    requesterAccountId: string;
    workspace: ManagedWorkspaceRefV2;
    lifetime: AbortSignal;
    holder?: ManagedSessionTargetRequest['holder'];
}>;
export type ManagedWorkspaceSyncTarget = Pick<ManagedSessionTarget,
    'id' | 'platform' | 'home' | 'exec' | 'putFile' | 'openChannel' | 'ensureWorkspaceRuntime'>
    & Partial<Pick<ManagedSessionTarget, 'holderPath' | 'helperPath'>>;

export function createManagedMachineAcquisitionDriver(input: ManagedMachineAcquisitionDriverInput) {
    const inFlight = new Map<string, Promise<JsonValue | null>>();
    async function reconcileOnce(params: Parameters<typeof reconcileManagedMachine>[0]): Promise<void> {
        const active = inFlight.get(params.machine.id);
        if (active) { await active; return; }
        const work = reconcileManagedMachine(params);
        inFlight.set(params.machine.id, work);
        try { await work; } finally { if (inFlight.get(params.machine.id) === work) inFlight.delete(params.machine.id); }
    }
    const nativeLifetimeRenewal = (machine: ManagedMachineFullV1) => input.runtimeRegistry.contributes.machineProvisioners?.find(candidate =>
        candidate.identity.pluginId === machine.launch.provider.pluginId && candidate.identity.localId === machine.launch.provider.localId
        && candidate.definition.schemaVersion === machine.launch.schemaVersion)?.definition.actions.renew;
    async function openPolicyMachine(machine: ManagedMachineV1, options: Pick<ManagedMachineExecutionOptions, 'requestId' | 'signal' | 'context'>,
        action: ManagedMachineActionIdV1, hydrator: ManagedPresetHydrator, sessionId?: string): Promise<ManagedMachineFullV1> {
        if (!isManagedOpaquePresetMachineV1(machine)) {
            return machine;
        }
        // Policy census is deliberately structural. Context is the sole cold
        // daemon delivery edge for an opaque snapshot before a native effect.
        const client = createManagedMachineControllerClient(input, options, action, hydrator);
        client.assertConnection(machine);
        const context = await client.post('/v1/machines/managed/controller/context', {
            homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision,
            controller: input.controller, ...(sessionId ? { sessionId } : {}),
        }, ManagedControllerContextOutputV1Schema, options.signal, sessionId ? SESSION_SPAWN_NEW_ACTION_ID_V1 : undefined);
        const retained = await normalizeManagedPresetCarrier(context, hydrator, options.signal);
        if (retained.machine.id !== machine.id || retained.machine.homeId !== machine.homeId
            || retained.machine.intentRevision !== machine.intentRevision) {
            throw new ManagedMachineControllerError('intent_changed');
        }
        client.assertConnection(retained.machine);
        return retained.machine;
    }
    async function openTarget(request: ManagedSessionTargetRequest): Promise<ManagedSessionTarget>;
    async function openTarget(request: ManagedWorkspaceSyncTargetRequest): Promise<ManagedWorkspaceSyncTarget>;
    async function openTarget(targetRequest: ManagedSessionTargetRequest | ManagedWorkspaceSyncTargetRequest): Promise<ManagedSessionTarget | ManagedWorkspaceSyncTarget> {
        const sync = 'relationshipId' in targetRequest ? targetRequest : undefined;
        const request = 'sessionId' in targetRequest ? targetRequest : {
            ...targetRequest, sessionId: undefined, committedSessionId: undefined, operation: undefined,
        };
        if (sync && (sync.workspace.managedId !== sync.managedId || sync.workspace.serverId !== input.homeId
            || sync.workspace.controller.machineId !== input.controller.machineId
            || sync.workspace.controller.installationId !== input.controller.installationId)) {
            throw new ManagedMachineControllerError('admission_unavailable');
        }
        const preparationSignal = request.operation
            ? AbortSignal.any([request.lifetime, request.operation.signal]) : request.lifetime;
        preparationSignal.throwIfAborted();
        if (!input.readPolicyCurrent) throw new ManagedMachineControllerError('admission_unavailable');
        const readCurrent = input.readPolicyCurrent;
        const initial = await readCurrent(request.managedId, preparationSignal);
        if (!initial || initial.id !== request.managedId) throw new ManagedMachineControllerError('admission_unavailable');
        const admitsRequester = (row: ManagedMachineV1): boolean => row.custodianAccountId === request.requesterAccountId
            || (!sync && row.acquisitionMode === 'resource-bound' && Boolean(request.committedSessionId)
                && row.enrollmentAccountId === request.requesterAccountId);
        if (!admitsRequester(initial)) throw new ManagedMachineControllerError('managed_target_access_unavailable');
        // The authority ends with its admitted lifetime, and when the row stops admitting this requester
        // (custody handed over, row gone): every running channel is aborted then.
        const revoked = new AbortController();
        const lifetime = AbortSignal.any([request.lifetime, revoked.signal]);
        const finiteSignal = AbortSignal.any([preparationSignal, revoked.signal]);
        const hydrator = createManagedPresetHydrator(input);
        const options = { requestId: sync ? `workspace-sync-target:${sync.relationshipId}` : `session-target:${request.sessionId}`,
            signal: lifetime, context: request.operation };
        const admit = async (row: ManagedMachineV1 | null, signal = lifetime): Promise<ManagedMachineFullV1> => {
            if (!row || row.id !== request.managedId) { revoked.abort(); throw new ManagedMachineControllerError('admission_unavailable'); }
            if (!admitsRequester(row)) {
                revoked.abort();
                throw new ManagedMachineControllerError('managed_target_access_unavailable');
            }
            return await openPolicyMachine(row, { ...options, signal }, 'machines.managed.inspect', hydrator, request.committedSessionId);
        };
        let current = await admit(initial, finiteSignal);
        if (current.acquisitionMode === 'resource-bound' && request.operation && !request.committedSessionId) {
            throw new ManagedMachineControllerError('admission_unavailable');
        }
        const authority = createManagedNativeInvocation({ input, options, machine: current,
            ...(sync ? { action: 'workspace.sync.relationship.create' as const,
                workspaceSyncTarget: { relationshipId: sync.relationshipId, lifetime } }
                : { action: 'session.spawn_new' as const, sessionTarget: { sessionId: request.sessionId!, lifetime } }) }, () => current!);
        const invoke = authority.invoke;
        if (!current.resource) throw new ManagedMachineControllerError('admission_unavailable');
        const correlation = { resource: current.resource };
        // Pushed row changes (no polling): a hand-over or removal revokes even an idle open channel.
        const unsubscribe = input.subscribeManagedMachineChanges?.(change => {
            if (lifetime.aborted) return;
            if (change?.kind === 'managed' && !change.managedIds.includes(request.managedId)) return;
            if (change?.kind === 'machines' && !change.machineIds.includes(input.controller.machineId)) return;
            return readCurrent(request.managedId, lifetime).then(async row => {
                try { current = await admit(row); authority.assertManagedTargetCurrent(correlation.resource.value); }
                catch { revoked.abort(); }
            }, () => undefined);
        });
        if (unsubscribe) lifetime.addEventListener('abort', () => unsubscribe(), { once: true });
        let io = createManagedNativeBootstrapIO(correlation, invoke);
        let openChannel: ManagedSessionTarget['openChannel'] = (argv, signal) => openManagedNativeChannel(correlation, invoke, { argv, signal });
        let placed: Readonly<{ platform: ManagedGuestPlatform }> & Partial<Pick<ManagedSessionTarget, 'holderPath' | 'helperPath' | 'socketDirectory'>>;
        let ensureWorkspaceRuntime!: ManagedSessionTarget['ensureWorkspaceRuntime'];
        try {
            const carrier = ManagedBootstrapCarrierV1Schema.parse(await invoke('bootstrap', await authority.readBootstrapInput(), { signal: finiteSignal }));
            if (carrier.kind === 'ssh') {
                const credential = await authority.materializeBootstrapCredential(carrier.credentialRef);
                const release = () => { void credential.dispose().catch(() => logger.warn('[managed] Session SSH credential cleanup failed')); };
                lifetime.addEventListener('abort', release, { once: true });
                if (lifetime.aborted) { release(); lifetime.throwIfAborted(); }
                const trust = await prepareManagedSessionSshTrust({ correlation: { homeId: current.homeId, managedId: current.id },
                    carrier, guestHostPublicKey: credential.guestHostPublicKey });
                finiteSignal.throwIfAborted();
                authority.assertManagedTargetCurrent(correlation.resource.value);
                const ssh = createManagedSshSessionTransport({ carrier, credentialPath: credential.path,
                    knownHostsPath: trust.knownHostsPath, lifetime });
                io = ssh.io;
                openChannel = ssh.openChannel;
            }
            placed = request.holder ? await ensureManagedGuestSessionHolder({ io, version: request.holder.version,
                resolveArtifacts: request.holder.resolveArtifacts, signal: finiteSignal })
                : { platform: await probeManagedNativeGuestPlatform(io.exec, finiteSignal) };
            const setup = hydrator.readSetupDefinition(current);
            const setupRemaining = current.machineSetup?.state !== 'succeeded' && current.machineSetup?.state !== 'skipped'
                && managedMachineSetupHasWorkV1(setup);
            const selectedExecution = hydrator.readPresetDefinition(current)?.preparationExecution;
            const channel = resolveManagedCliReleaseChannelSync({ argv: process.argv, invokedPath: process.argv[1], processEnv: process.env }).label;
            let setupBinaryPath = selectedExecution?.binaryPath ?? resolveRemoteInstalledFirstPartyBinaryPath({ componentId: 'happier-cli',
                remoteHomeDir: `${placed.platform.home}/.happier`, channel });
            const setupClient = () => createManagedMachineControllerClient(input, {
                requestId: request.operation?.actionRequestId ?? options.requestId, signal: finiteSignal, context: request.operation,
            }, 'machines.managed.inspect', hydrator);
            let cliInstallationRequired = selectedExecution?.updateCli === true || !current.bootstrapInstalled && !selectedExecution;
            const ensureRecipeInterpreter = async () => {
                if (cliInstallationRequired) {
                    if (!current.preset && !sync) throw new ManagedMachineControllerError('admission_unavailable');
                    request.operation?.operationOwnerUpdate?.update({ progress: {
                        phase: 'ssh.installCli', label: 'Installing Happier',
                    } });
                    const installed = await installManagedNativePayload({
                        channel,
                        homeUrl: input.serverUrl, ...placed.platform, dedicatedIdentity: false,
                        resource: correlation.resource.value, signal: finiteSignal,
                        exec: io.exec, putFile: io.putFile, bootstrapExec: io.exec, cleanupExec: io.exec,
                    });
                    setupBinaryPath = installed.binaryPath;
                    finiteSignal.throwIfAborted();
                    if (!sync) current = await setupClient().reportBoundSessionSetup(current, {
                        homeId: current.homeId, managedId: current.id, presetId: current.preset!.id, presetRevision: current.preset!.revision,
                        target: { kind: 'bound', controller: input.controller, sessionId: request.committedSessionId! }, bootstrapInstalled: true,
                    });
                    cliInstallationRequired = false;
                }
                return setupBinaryPath;
            };
            ensureWorkspaceRuntime = async () => {
                lifetime.throwIfAborted();
                const binaryPath = await ensureRecipeInterpreter();
                return { binaryPath };
            };
            if (current.acquisitionMode === 'resource-bound' && request.operation && selectedExecution?.updateCli) {
                await ensureRecipeInterpreter();
            }
            if (current.acquisitionMode === 'resource-bound' && request.operation && setupRemaining && setup) {
                await runBoundSessionSetup({ machine: current, setup, sessionId: request.committedSessionId!,
                    requesterAccountId: request.requesterAccountId, transport: io, binaryPath: setupBinaryPath, ensureRecipeInterpreter,
                    platform: placed.platform, recipes: input.runtimeRegistry.contributes.machineRecipes ?? [],
                    sourceFacts: hydrator.readPresetDefinition(current)?.setupSourceFacts,
                    savedSecrets: { credentials: input.credentials, serverHttpBaseUrl: input.serverUrl,
                        authorization: request.operation.externalActionExecutionAuthorization },
                    operation: request.operation, signal: finiteSignal,
                    report: async (state, sourceFacts, errorCode) => {
                        current = await setupClient().reportBoundSessionSetup(current, {
                            homeId: current.homeId, managedId: current.id, presetId: current.preset!.id, presetRevision: current.preset!.revision,
                            target: { kind: 'bound', controller: input.controller, sessionId: request.committedSessionId! },
                            state, operation: { operationId: request.operation!.operationAcceptance?.operationId ?? request.operation!.actionRequestId! },
                            sourceFacts, ...(errorCode === undefined ? {} : { errorCode }),
                        });
                    },
                });
            }
        } catch (error) {
            revoked.abort();
            throw error;
        }
        return Object.freeze({
            id: `managed:${current.id}`, holderPath: placed.holderPath, helperPath: placed.helperPath, socketDirectory: placed.socketDirectory,
            platform: placed.platform, home: placed.platform.home, lifetime,
            // Only the creating provider can attest an isolated target that Happier created.
            ...(correlation.resource.origin === 'created' ? { agentEnvironment: { IS_SANDBOX: '1' } } : {}),
            putFile: (path, bytes, signal) => io.putFile({ path, bytes, signal }),
            exec: async (command, signal) => {
                // The command (Agent args, paths) crosses as the exec's input, never as provider argv:
                // host carriers (`docker exec`, `coder ssh`) and the guest list process argv.
                const result = await io.exec({ command: 'exec sh -s', input: command, signal });
                return { status: result.status, stdout: result.stdout, stderr: result.stderr };
            },
            openChannel,
            ensureWorkspaceRuntime,
        });
    }
    return {
        /** Existing custody admits transport only; every guest shares the row's custodian Account. */
        openSessionTarget: (request: ManagedSessionTargetRequest) => openTarget(request),
        /** The Account relationship owns this channel independently of any creating Session. */
        openWorkspaceSyncTarget: (request: ManagedWorkspaceSyncTargetRequest) => openTarget(request),
        async snapshotAdmitted({ machine, label, reason, options }: ManagedNativeSnapshotRequest): Promise<MachineProvisionerSnapshotResultV1> {
            options.signal?.throwIfAborted();
            const contribution = input.runtimeRegistry.contributes.machineProvisioners?.find(candidate =>
                candidate.identity.pluginId === machine.launch.provider.pluginId
                && candidate.identity.localId === machine.launch.provider.localId
                && candidate.definition.schemaVersion === machine.launch.schemaVersion);
            if (!contribution?.definition.actions.snapshot || !contribution.definition.snapshot) {
                return { kind: 'unsupported', code: 'native_snapshot_unsupported' };
            }
            if (!machine.resource || options.context?.operationAcceptance?.actionId !== 'deployments.backups.restore') {
                return { kind: 'refused', code: 'admission_unavailable' };
            }
            try {
                const native = createManagedNativeInvocation({ input, options, machine, action: 'deployments.backups.restore' }, () => machine);
                return MachineProvisionerSnapshotResultV1Schema.parse(await native.invoke('snapshot', {
                    resource: machine.resource.value, expectedMachineRevision: machine.intentRevision, label, reason,
                }));
            } catch (error) {
                options.signal?.throwIfAborted();
                const nativeCause = error instanceof ManagedMachineControllerError && error.details?.kind === 'managedNative'
                    ? error.details.nativeCause : undefined;
                return { kind: 'unknown', code: error instanceof ManagedMachineControllerError ? error.code : 'native_snapshot_outcome_unknown',
                    ...(nativeCause ? { nativeCause } : {}) };
            }
        },
        async supportsNativeLifetimeRenewal(machine: ManagedMachineV1,
            options?: Pick<ManagedMachineExecutionOptions, 'requestId' | 'signal'>): Promise<boolean> {
            const hydrator = createManagedPresetHydrator(input);
            const current = await openPolicyMachine(machine, options ?? { requestId: machine.id },
                machine.desired === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set', hydrator);
            return Boolean(nativeLifetimeRenewal(current) && current.observation?.availability === 'present'
                && current.observation.power === 'running' && current.observation.nativeExpiry !== undefined);
        },
        async reconcileNativeCredentials(machine: ManagedMachineV1, options: ManagedMachineExecutionOptions): Promise<void> {
            const ref = machine.resource?.contributionRef;
            const contribution = input.runtimeRegistry.contributes.machineProvisioners?.find(candidate =>
                candidate.identity.pluginId === ref?.pluginId && candidate.identity.localId === ref?.localId);
            if (!contribution?.definition.nativeCredentialDelivery) return;
            if (!input.externalActionMachineRequestPrivateKey || !input.prepareTeamCredentialNativeSource) {
                throw new ManagedMachineControllerError('credential_unavailable');
            }
            const { readManagedMachinePolicyCensus } = await import('@/daemon/startup/managedMachinePolicyRuntime');
            const census = await readManagedMachinePolicyCensus({ homeId: input.homeId, controller: input.controller,
                custodianAccountId: machine.custodianAccountId, privateKey: input.externalActionMachineRequestPrivateKey,
                token: input.token, serverUrl: input.serverUrl, signal: options.signal, nativeCredentialManagedId: machine.id });
            const admitted = census.machines.find(row => row.id === machine.id);
            const policy = census.nativeCredentialPolicies?.find(row => row.managedId === machine.id);
            if (!admitted || !policy) throw new ManagedMachineControllerError('admission_unavailable');
            const action = 'machines.managed.credentials.install' as const;
            const hydrator = createManagedPresetHydrator(input);
            const client = createManagedMachineControllerClient(input, options, action, hydrator);
            client.assertConnection(admitted);
            const context = await client.post('/v1/machines/managed/controller/context', {
                homeId: admitted.homeId, managedId: admitted.id, expectedIntentRevision: admitted.intentRevision,
                controller: input.controller, includeNativeCredentialBindings: true,
            }, ManagedControllerContextOutputV1Schema);
            const retained = await normalizeManagedPresetCarrier(context, hydrator, options.signal);
            client.assertConnection(retained.machine);
            const invocation = createManagedNativeInvocation({ input, options, client, machine: retained.machine, action,
                nativePolicyAdmission: true }, () => retained.machine);
            const result = await applyManagedNativeCredentialPolicy({ machine: retained.machine, bindings: policy.bindings,
                desiredBindingKeys: policy.desiredBindingKeys, prepareSource: input.prepareTeamCredentialNativeSource,
                invoke: invocation.invoke, signal: options.signal });
            if (result.kind !== 'confirmed') throw new ManagedMachineControllerError(result.code);
        },
        async executePolicy(structuralMachine: ManagedMachineV1, purpose: ManagedPolicyPurposeV1,
            options: ManagedMachineExecutionOptions): Promise<JsonValue> {
            const hydrator = createManagedPresetHydrator(input);
            if (!options.context?.operationAcceptance?.operationId || !options.context.operationOwnerUpdate
                || options.context.externalActionCredential || options.context.externalActionExecutionAuthorization) {
                throw new ManagedMachineControllerError('admission_unavailable');
            }
            const machine = await openPolicyMachine(structuralMachine, options,
                structuralMachine.desired === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set', hydrator);
            if (purpose.kind === 'accepted-input-start' && purpose.target.origin.kind === 'finite-command') {
                const origin = options.actionOrigin?.binding;
                if (!origin || origin.requestId !== purpose.target.origin.actionRequestId
                    || origin.serverIdentityId !== machine.homeId || origin.machineId !== machine.enrolledMachineId
                    || !isExternalActionManagedWakeRootV1(origin)) {
                    throw new ManagedMachineControllerError('admission_unavailable');
                }
            }
            const nativeLifetime = purpose.kind === 'retention' && nativeLifetimeRenewal(machine)
                ? createManagedNativeInvocation({ input, options, machine, action: 'machines.managed.power.set',
                    client: createManagedMachineControllerClient(input, options, 'machines.managed.power.set', hydrator), nativePolicyAdmission: true }, () => machine) : undefined;
            const prepared = purpose.kind === 'retention'
                ? await prepareManagedRetentionPolicy({ input, options, machine, purpose,
                    ...(nativeLifetime ? { renew: async (deadlineAt?: number) => MachineProvisionerRenewResultV1Schema.parse(
                        await nativeLifetime.invoke('renew', { resource: machine.resource!.value,
                            ...(deadlineAt === undefined ? {} : { deadlineAt }) })) } : {}) })
                : { purpose, bridge: undefined, nativeExpiry: undefined, onActivityChange: undefined };
            let ownerStarted = false;
            let failureClient: ManagedMachineControllerClient | undefined;
            try {
                // A mandatory native timer effects Stop itself. Observe its
                // normal provider fact; there is no new power intent to admit.
                if (prepared.nativeExpiry !== undefined || purpose.kind === 'retention' && machine.retention.kind === 'until-delete') {
                    const wait = createManagedNativeObservationWait(options.signal);
                    const bridge = prepared.bridge;
                    const changes = bridge && prepared.onActivityChange ? {
                        waitForChange: async (signal: AbortSignal) => { await bridge.waitForChange(signal); },
                        onChange: prepared.onActivityChange,
                    } : undefined;
                    for (;;) {
                        if (options.signal?.aborted) throw new ManagedMachineControllerError('cancelled');
                        const observed = await this.execute('machines.managed.inspect', { homeId: machine.homeId, managedId: machine.id }, options);
                        const row = ManagedControllerMachineOutputV1Schema.parse(observed).machine;
                        if (prepared.nativeExpiry === undefined || row.observation?.availability === 'absent'
                            || row.observation?.power === 'stopped' || row.observation?.power === 'suspended') return observed;
                        await wait(changes);
                    }
                }
                const admissionOptions = { ...options, policyPurpose: prepared.purpose, policyMachine: machine };
                const admissionClient = createManagedMachineControllerClient(input, admissionOptions,
                    purpose.kind === 'creation-cleanup' ? 'machines.managed.delete' : 'machines.managed.power.set', hydrator);
                admissionClient.assertConnection(machine);
                // Ask may settle before admit-policy runs. The original signed
                // target is already sufficient for the pending owner's exact CAS.
                failureClient = admissionClient;
                const policyInput = ManagedPolicyAdmissionInputV1Schema.parse({ ...admissionClient.correlation(machine), purpose: prepared.purpose });
                // Preparation projects the reviewed effect without changing the
                // retained row. Shared Ask owns admission as well as native IO.
                const preview = (await normalizeManagedPresetCarrier(await admissionClient.post(
                    '/v1/machines/managed/controller/prepare-policy', policyInput, ManagedPolicyAdmissionOutputV1Schema),
                hydrator, options.signal)).machine;
                let accepted: ReturnType<typeof ManagedIntentResultSchema.parse> | undefined;
                const runApproved = async (context?: ActionExecutorContext): Promise<ManagedMachineFullV1> => {
                    if (context) {
                        if (context.operationAcceptance?.operationId !== options.context?.operationAcceptance?.operationId
                            || context.signal !== options.signal || context.operationOwnerUpdate !== options.context?.operationOwnerUpdate) {
                            throw new ManagedMachineControllerError('admission_unavailable');
                        }
                    }
                    if (options.signal?.aborted) throw new ManagedMachineControllerError('cancelled');
                    if (purpose.kind === 'creation-cleanup' && machine.archivedAt !== undefined) {
                        throw new ManagedMachineControllerError('native_resource_unavailable');
                    }
                    // /current belongs to an already admitted request. This new
                    // policy still has no custody there; admit-policy atomically
                    // checks its reviewed revision, purpose and controller instead.
                    const admitted = await normalizeManagedPresetCarrier(await admissionClient.post(
                        '/v1/machines/managed/controller/admit-policy', policyInput, ManagedPolicyAdmissionOutputV1Schema),
                    hydrator, options.signal);
                    const approvedContext = context ?? options.context!;
                    const policyAction = options.runPolicyAction;
                    let initialApprovalPending = true;
                    const currentOptions: ManagedMachineExecutionOptions = { ...admissionOptions, requestId: admitted.requestId,
                        policyMachine: admitted.machine, context: approvedContext,
                        runPolicyAction: policyAction ? (currentMachine, runEffect) => {
                            // Admission already belongs to this approval. Reuse
                            // it once; new guest work requires the same owner
                            // to reevaluate policy after returning to idle.
                            if (initialApprovalPending) {
                                initialApprovalPending = false;
                                return runEffect(approvedContext);
                            }
                            return policyAction(currentMachine, runEffect);
                        } : undefined };
                    const action = admitted.machine.desired === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set';
                    const client = createManagedMachineControllerClient(input, currentOptions, action, hydrator);
                    accepted = ManagedIntentResultSchema.parse({ kind: 'accepted', managedId: admitted.machine.id,
                        intentRevision: admitted.machine.intentRevision, operation: { operationId: options.context!.operationAcceptance!.operationId } });
                    options.context!.operationOwnerUpdate!.update({ domainRef: { kind: 'managedMachine', id: admitted.machine.id } });
                    currentOptions.context?.operationAcceptance?.accept(accepted);
                    ownerStarted = true;
                    return await reconcileManagedIntent({ input: { ...input, ...(prepared.bridge ? { managedGuestActivity: prepared.bridge } : {}) },
                        options: currentOptions, client, machine: admitted.machine, action });
                };
                const settled = await (options.runPolicyAction ? options.runPolicyAction(preview, runApproved) : runApproved());
                if (purpose.kind === 'accepted-input-start' && (settled.observation?.power !== 'running'
                    || settled.observation.availability !== 'present' || settled.observation.storage === 'lost')) {
                    throw new ManagedMachineControllerError('native_intent_unconfirmed');
                }
                if (!accepted) throw new ManagedMachineControllerError('admission_unavailable');
                return accepted;
            } catch (error) {
                if (purpose.kind === 'accepted-input-start'
                    && purpose.target.origin.kind === 'session-input' && failureClient
                    // Retiring an obsolete compute wake does not reject the
                    // input that the reconnected guest can now activate.
                    && (ownerStarted || !options.policySchedulerSignal?.aborted)
                    // Before native reconciliation, Ask/admission failures are
                    // definite. After it starts, only a native refusal proves
                    // failure; unknown IO stays with the native intent owner.
                    && (!ownerStarted || error instanceof ManagedMachineNativeRefusal)) {
                    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
                    const failureCode = error instanceof ManagedMachineNativeRefusal ? 'managed_start_refused'
                        : code === 'approval_rejected' ? 'managed_start_denied'
                            : code === 'approval_expired' ? 'managed_start_expired'
                                : code === 'approval_canceled' || code === 'action_disabled' || code === 'permission_denied'
                                    ? 'managed_start_refused' : 'managed_start_failed';
                    await failureClient.post('/v1/machines/managed/controller/activation-failed', ManagedPendingActivationFailureRequestV1Schema.parse({
                        target: purpose.target, failureCode,
                    }), PendingActivationFailureResponseV1Schema, null);
                }
                throw error;
            } finally {
                await prepared.bridge?.dispose?.();
            }
        },
        async execute(action: ManagedMachineActionIdV1, body: unknown, options: ManagedMachineExecutionOptions): Promise<JsonValue | null> {
            const parsed = ManagedMachineActionInputSchemasV1[action].parse(body);
            const review = 'selection' in parsed ? resolveManagedAcquireReviewV1(ManagedAcquireInputV1Schema.parse(parsed)) : parsed;
            const hydrator = createManagedPresetHydrator(input);
            const client = createManagedMachineControllerClient(input, options, action, hydrator);
            if (MANAGED_CONTROL_ACTION_IDS_V1.some(control => control === action)) {
                if (review.homeId !== input.homeId) throw new ManagedMachineControllerError('controller_unavailable');
                const operationId = options.context?.operationAcceptance?.operationId;
                const executesIntent = action === 'machines.managed.power.set' || action === 'machines.managed.rebuild' || action === 'machines.managed.delete';
                if (executesIntent && !operationId) {
                    throw new ManagedMachineControllerError('admission_unavailable');
                }
                const request = ManagedControlAdmissionInputV1Schema.parse({ action, requestId: options.requestId, input: parsed });
                const unconfirmed = (error: ManagedMachineControllerError, committed: true | null) => {
                    const failure = projectUnexpectedActionFailureV1(committed, options.requestId);
                    return { ...failure, failureCause: error.failureCause ?? projectActionFailureCauseV1(error, action),
                        details: { ...(options.requestId ? { requestId: options.requestId } : {}), ...error.details } };
                };
                let rawAdmission: ReturnType<typeof ManagedAdmissionOutputV1Schema.parse>;
                try {
                    rawAdmission = await client.post('/v1/machines/managed/controller/admit-control', request, ManagedAdmissionOutputV1Schema);
                } catch (error) {
                    // Lost transport/schema acknowledgement cannot establish that
                    // this write rolled back. database_connection_unavailable also
                    // covers raw pool errors without pre-commit evidence. Only the
                    // transaction owner's confirmed rollback refusal is definite;
                    // pre-request currentness failures retain their own boundary.
                    if (!executesIntent || !operationId || !(error instanceof ManagedMachineControllerError)) throw error;
                    if (!isUncertainManagedControllerRequest(error)) throw error;
                    const managedId = 'managedMachineId' in request.input ? request.input.managedMachineId : request.input.managedId;
                    options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: managedId } });
                    return unconfirmed(error, null);
                }
                const admission = await normalizeManagedPresetCarrier(rawAdmission, hydrator, options.signal);
                // Move's destination is in the input; the current executor is
                // validated by the admitted row/server, not that destination.
                if (request.action === MANAGED_RESIZE_ACTION_ID_V1) {
                    const machine = admission.machine;
                    client.assertConnection(machine);
                    // The Home projection deliberately has no private provider
                    // definition. The installed daemon declaration is the sole
                    // executable capability for the locally opened snapshot.
                    const provisioner = input.runtimeRegistry.contributes.machineProvisioners?.find(candidate =>
                        candidate.identity.pluginId === machine.launch.provider.pluginId
                        && candidate.identity.localId === machine.launch.provider.localId
                        && candidate.definition.schemaVersion === machine.launch.schemaVersion)?.definition;
                    if (!provisioner) throw new ManagedMachineControllerError('provider_unavailable');
                    options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: machine.id } });
                    const size = hydrator.isOpaque(machine)
                        ? await hydrator.prepareResize(machine, 'presetContentOverride' in request.input ? request.input.presetContentOverride : undefined, options.signal)
                        : 'size' in request.input ? request.input.size
                            : (() => { throw new ManagedMachineControllerError('credential_unavailable'); })();
                    let native: ReturnType<typeof createManagedNativeInvocation> | undefined;
                    const resize = await executeManagedMachineResize({ machine, provisioner,
                        size,
                        invoke: (role, body, io) => {
                            native ??= createManagedNativeInvocation({ input, options, client, machine, action }, () => machine);
                            return native.invoke(role, body, io);
                        }, io: { signal: options.signal },
                        guestStartup: { transport: provisioner.bootstrapTransport,
                            channel: resolveManagedCliReleaseChannelSync({ argv: process.argv, invokedPath: process.argv[1], processEnv: process.env }).label },
                        waitForObservation: createManagedNativeObservationWait(options.signal) });
                    const reported = await hydrator.prepareResizeReport({ homeId: machine.homeId,
                        managedId: machine.id, requestId: options.requestId, ...resize }, options.signal);
                    await client.post('/v1/machines/managed/controller/report-resize', reported.report, ManagedControllerMachineOutputV1Schema, null);
                    return projectNativeJsonValueForTransport(ManagedResizeOutputV1Schema.parse(reported.output));
                }
                if (!executesIntent) return projectNativeJsonValueForTransport(hydrator.structural(admission.machine));
                client.assertConnection(admission.machine);
                if (!operationId) throw new ManagedMachineControllerError('admission_unavailable');
                const accepted = ManagedIntentResultSchema.parse({ kind: 'accepted', managedId: admission.machine.id,
                    intentRevision: admission.machine.intentRevision, operation: { operationId } });
                options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: admission.machine.id } });
                options.context?.operationAcceptance?.accept(accepted);
                try {
                    await reconcileManagedIntent({ input, options, client, machine: admission.machine, action,
                        ...(action === 'machines.managed.rebuild' ? { rebuild: ManagedMachineActionInputSchemasV1['machines.managed.rebuild'].parse(parsed) } : {}) });
                } catch (error) {
                    // The successful admission response proves desired intent committed.
                    // Submission refused before native IO is definite. A failed
                    // outcome report cannot establish that native IO rolled back.
                    if (!(error instanceof ManagedMachineControllerError) || error instanceof ManagedMachineNativeRefusal
                        || error instanceof ManagedMachineNativeObservationFailure
                        || error.details?.kind === 'managedControllerRequest'
                            && error.details.path === '/v1/machines/managed/controller/submit-intent'
                            && !isUncertainManagedControllerRequest(error)
                        || (!error.details && error.code !== 'native_intent_unconfirmed')) throw error;
                    return unconfirmed(error, true);
                }
                return accepted;
            }
            if (review.homeId !== input.homeId || ('controller' in review && review.controller
                && (review.controller.machineId !== input.controller.machineId || review.controller.installationId !== input.controller.installationId))) {
                throw new ManagedMachineControllerError('controller_unavailable');
            }
            if (action === 'machines.managed.credentials.install') {
                const request = ManagedMachineActionInputSchemasV1[action].parse(parsed);
                const machine = unwrapManagedMachineReadV1(await client.post(managedMachineActionEndpointPathV1('machines.managed.get'), {
                    homeId: request.homeId, managedId: request.managedId,
                }, ManagedGetOutputV1Schema));
                client.assertConnection(machine);
                const retainedContext = await client.post('/v1/machines/managed/controller/context', {
                    homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision,
                    controller: input.controller, includeNativeCredentialBindings: true,
                }, ManagedControllerContextOutputV1Schema);
                let retained = await normalizeManagedPresetCarrier(retainedContext, hydrator, options.signal);
                client.assertConnection(retained.machine);
                if (!retained.nativeCredentialBindings || !retained.nativeCredentialDesiredBindingKeys) return { kind: 'refused', code: 'credential_unavailable' };
                if (!input.prepareTeamCredentialNativeSource) return { kind: 'refused', code: 'provider_unavailable' };
                const currentOptions = { ...options, requestId: retained.requestId };
                const currentClient = createManagedMachineControllerClient(input, currentOptions, action, hydrator);
                try {
                    const submitted = await currentClient.post('/v1/machines/managed/controller/report', {
                        ...currentClient.correlation(retained.machine), credentialDelivery: { request, phase: 'submitted' },
                    }, ManagedControllerSubmitOutputV1Schema, null);
                    if (!submitted.submitted) return { kind: 'unknown', code: 'action_outcome_unknown' };
                    // The durable exact-request claim precedes every vendor
                    // effect. Reread its complete desired census under that claim.
                    const currentContext = await currentClient.post('/v1/machines/managed/controller/context', {
                        homeId: retained.machine.homeId, managedId: retained.machine.id,
                        expectedIntentRevision: retained.machine.intentRevision,
                        controller: input.controller, includeNativeCredentialBindings: true,
                    }, ManagedControllerContextOutputV1Schema);
                    retained = await normalizeManagedPresetCarrier(currentContext, hydrator, options.signal);
                    currentClient.assertConnection(retained.machine);
                    if (!retained.nativeCredentialBindings || !retained.nativeCredentialDesiredBindingKeys) return { kind: 'unknown', code: 'action_outcome_unknown' };
                } catch {
                    return { kind: 'unknown', code: 'action_outcome_unknown' };
                }
                const appliedPolicy = { ownedBindingKeys: retained.nativeCredentialBindings.map(binding => binding.safeFacet.bindingKey),
                    desiredBindingKeys: retained.nativeCredentialDesiredBindingKeys };
                const invocation = createManagedNativeInvocation({ input, options: currentOptions, client: currentClient,
                    machine: retained.machine, action }, () => retained.machine);
                const result = await composeManagedNativeCredentials({ request, machine: retained.machine,
                    bindings: retained.nativeCredentialBindings, desiredBindingKeys: retained.nativeCredentialDesiredBindingKeys,
                    prepareSource: input.prepareTeamCredentialNativeSource,
                    invoke: invocation.invoke, signal: options.signal });
                try {
                    const completed = await currentClient.post('/v1/machines/managed/controller/report', {
                        ...currentClient.correlation(retained.machine), credentialDelivery: { request, result,
                            ...(result.kind === 'confirmed' ? { appliedPolicy } : {}) },
                    }, ManagedControllerCredentialDeliveryReportOutputV1Schema, null);
                    return completed.credentialDeliveryResult;
                } catch {
                    // A vendor acknowledgement does not prove Home retained the
                    // outcome. Do not release launch on an unrecorded result.
                    return result.kind === 'refused' ? result : { kind: 'unknown', code: 'action_outcome_unknown' };
                }
            }
            if (action === 'machines.provisioners.list') {
                const request = ManagedMachineActionInputSchemasV1[action].parse(parsed);
                const { resolveRegistryConnectedAccountActionPurposeAuthorizations } = await import('@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations');
                const signal = options.signal ?? new AbortController().signal;
                // An existing machine needs its own current descriptor, not
                // acquisition credentials for unrelated provisioners.
                // The controller is the machine the guest is created on, so a provisioner declared
                // for other operating systems cannot run here and is not offered.
                const providers = (input.runtimeRegistry.contributes.machineProvisioners ?? []).filter(provider =>
                    (provider.definition.platforms as readonly string[]).includes(process.platform));
                const entries = providers.flatMap(provider => {
                    const occurrenceId = input.runtimeRegistry.readPluginOccurrenceId?.(provider.pluginId);
                    return occurrenceId ? [{ contribution: provider.identity, occurrenceId, descriptor: provider.definition,
                        acquireExecutionTarget: input.runtimeRegistry.contributes.actionsById!.get(buildQualifiedPluginContributionKey(
                            { pluginId: provider.pluginId, localId: provider.definition.actions.acquire }))!.admittedTarget!
                            .declaration.execution.target as ManagedProvisionerDiscoveryEntry['acquireExecutionTarget'],
                    }] : [];
                });
                return await executeManagedProvisionerDiscovery({ actionId: action, value: request,
                    controller: input.controller, entries, readCredentialPurposes: async provider => {
                    signal.throwIfAborted();
                    // Save/acquire admits exactly this Action's purposes. Other
                    // roles recheck captured selections when invoked; their
                    // private scopes cannot become extra acquisition choices.
                    const authorizations = resolveRegistryConnectedAccountActionPurposeAuthorizations({
                        registry: input.runtimeRegistry.contributes,
                        qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId: provider.contribution.pluginId, localId: provider.descriptor.actions.acquire }),
                        resolveOptionalAccess: input.runtimeRegistry.resolveOptionalAccess,
                    });
                    if (!authorizations) return undefined;
                    return await Promise.all(authorizations.map(async authorization => {
                        const list = input.managedProviderOperationAuthority.listActionFormConnectedAccountOptions;
                        if (!list) throw new ManagedMachineControllerError('credential_unavailable');
                        const choices = await list({ purpose: authorization.purpose, serviceRefs: authorization.serviceRefs, signal });
                        signal.throwIfAborted();
                        const options = choices.flatMap(choice => 'nativeServicePath' in choice
                            ? [] : [{ value: choice.value, label: choice.label }]);
                        return { purpose: { consumer: provider.contribution, purpose: authorization.purpose.purpose }, options };
                    }));
                } });
            }
            if (action === 'machines.provisioners.check' || action === 'machines.provisioners.options') {
                const probe = ManagedMachineActionInputSchemasV1[action].parse(parsed);
                const entries = (input.runtimeRegistry.contributes.machineProvisioners ?? []).flatMap(provider => {
                    const occurrenceId = input.runtimeRegistry.readPluginOccurrenceId?.(provider.pluginId);
                    return occurrenceId ? [{ contribution: provider.identity, occurrenceId, descriptor: provider.definition,
                        acquireExecutionTarget: input.runtimeRegistry.contributes.actionsById!.get(buildQualifiedPluginContributionKey(
                            { pluginId: provider.pluginId, localId: provider.definition.actions.acquire }))!.admittedTarget!
                            .declaration.execution.target as ManagedProvisionerDiscoveryEntry['acquireExecutionTarget'],
                    }] : [];
                });
                const result = await executeManagedProvisionerDiscovery({ actionId: action, value: probe, entries,
                    invoke: async (provider, role, roleInput) => {
                const pluginId = provider.contribution.pluginId;
                const localId = provider.descriptor.actions[role]!;
                const roleHost = await resolveManagedRoleRuntime(input, pluginId, localId);
                const roleOccurrenceId = roleHost.runtimeRegistry.readPluginOccurrenceId?.(pluginId);
                if (!roleOccurrenceId) throw new ManagedMachineControllerError('provider_unavailable');
                const authorizations = await resolveManagedRoleCredentialAuthorizations(roleHost, provider.contribution, localId, probe.credentials,
                    { descriptor: provider.descriptor, launch: 'selectors' in probe ? probe.selectors : undefined });
                let current = true;
                const isCurrent = () => current && !options.signal?.aborted && roleHost.runtimeRegistry.readPluginOccurrenceId?.(pluginId) === roleOccurrenceId;
                const signal = options.signal ?? new AbortController().signal;
                const identity = { pluginId, localId };
                const declaration = roleHost.runtimeRegistry.contributes.actionsById?.get(buildQualifiedPluginContributionKey(identity));
                const binding: ConnectedAccountInvocationPurposeBinding = {
                    identity, operationId: options.context?.externalActionExecutionAuthorization?.binding.requestId ?? options.requestId,
                    purposes: authorizations.map(authorization => authorization.purpose),
                    purposeBindings: projectManagedMachineRolePurposeBindingsV1(authorizations),
                    ...(declaration?.pluginVersion ? { actionOperation: { pluginVersion: declaration.pluginVersion, signal,
                        resolveRequestHeaders: createExternalActionRequesterServerRequestHeaders(options.context) } } : {}),
                    isCurrent, managedOperation: { role, isCurrent: (currentRole) => currentRole === role && isCurrent() },
                };
                const activation = await roleHost.managedProviderOperationAuthority.activate({ ...binding, requestAuthUses: [] });
                try {
                    if (!activation.exactPurposeBindingSubjectId && !activation.executeBrokeredAction) throw new ManagedMachineControllerError('credential_unavailable');
                    const { executeContributedAction } = await import('@/plugins/runtime/invocation/actions/executeContributedAction');
                    const attempt = await executeContributedAction({ runtimeRegistry: roleHost.runtimeRegistry,
                        actionId: buildQualifiedPluginContributionKey({ pluginId, localId }),
                        expectedContributorOccurrenceId: roleOccurrenceId,
                        admittedConnectedAccountPurposeBinding: {
                            ...(activation.exactPurposeBindingSubjectId ? { exactPurposeBindingSubjectId: activation.exactPurposeBindingSubjectId } : {}),
                            ...(activation.executeBrokeredAction ? { executeBrokeredAction: activation.executeBrokeredAction } : {}),
                            isCurrent: () => isCurrent() && activation.isCurrent(),
                        },
                        input: roleInput,
                        ...(options.context?.recordOperationCredentialUse
                            ? { approvalContext: { recordOperationCredentialUse: options.context.recordOperationCredentialUse } } : {}),
                        context: { surface: 'plugin', invocationSurface: 'plugin', originSurface: 'cli', signal: options.signal, initiatingActionCaller: options.context?.actionCaller },
                    });
                    if (!attempt.matched) throw new ManagedMachineControllerError('provider_unavailable');
                    if (!attempt.result.ok) throw ManagedMachineControllerError.fromActionFailure(
                        projectContributedActionFailure(attempt.result), action, { pluginId, localId });
                    return attempt.result.result;
                } finally { current = false; await activation.cleanup(); }
                } });
                if ('available' in result) {
                        for (const prerequisite of result.prerequisites ?? []) {
                            const repair = prerequisite.repairAction;
                            if (!repair) continue;
                            const target = input.runtimeRegistry.contributes.actionsById?.get(buildQualifiedPluginContributionKey(repair.action));
                            if (!target || !input.runtimeRegistry.readPluginOccurrenceId?.(repair.action.pluginId)) {
                                throw new ManagedMachineControllerError('provider_unavailable');
                            }
                            let valid = false;
                            try { valid = target.definition.inputSchema === undefined
                                || compilePluginJsonSchema(target.definition.inputSchema)(repair.input); }
                            catch { /* Invalid provider-generated repair facts are not usable discovery results. */ }
                            if (!valid) throw new ManagedMachineControllerError('provider_unavailable');
                        }
                        // Native availability also serves retained-machine
                        // operations. Warn about new-guest enrollment without
                        // withdrawing that independent native capability.
                        const homeWarning = result.available ? readManagedGuestHomeWarning(input.homeTarget) : null;
                        return projectNativeJsonValueForTransport(homeWarning ? { ...result, ...homeWarning } : result);
                }
                return projectNativeJsonValueForTransport(result);
            }
            if (action === 'machines.managed.acquire') {
                const acquisition = ManagedAcquireInputV1Schema.parse(parsed);
                if (options.acquisitionMode === 'resource-bound' && !isManagedPresetAcquireInputV1(acquisition)) {
                    throw new ManagedMachineControllerError('invalid_request');
                }
                const hasAttendedEnrollmentRequirement = (identity: ManagedMachineFullV1['enrollmentIdentity']) => identity?.kind === 'dedicatedDaemonUser'
                    && identity.adminAccessAtCreation === 'ask'
                    && (options.context?.surface === 'agent' || options.context?.surface === 'mcp'
                        || options.context?.authority === 'account_automation' || options.context?.actionCaller?.kind === 'session');
                if (!isManagedPresetAcquireInputV1(acquisition) && hasAttendedEnrollmentRequirement(acquisition.enrollmentIdentity)) {
                    throw new ManagedMachineControllerError('enrollment_attendance_required');
                }
                const operationId = options.context?.operationAcceptance?.operationId;
                if (!operationId || (acquisition.agentStart && !options.runAgentStart)) throw new ManagedMachineControllerError('admission_unavailable');
                const { agentStart, ...computeInput } = acquisition;
                const hasCreationContinuation = Boolean(agentStart || options.runCreationContinuation);
                const runCreationContinuation = options.runCreationContinuation ?? (agentStart ? options.runAgentStart : undefined);
                let admittedExecutionOptions = options;
                let openedRequiresEnrollmentRead = false;
                const delegated = options.context?.externalActionExecutionAuthorization?.binding.managedAcquireDelegation === true;
                const needsPresetPolicy = isManagedPresetAcquireInputV1(acquisition)
                    && (options.acquisitionMode === 'resource-bound' || delegated || acquisition.retention === undefined || acquisition.wakeOnAcceptedMessage === undefined);
                if ((needsPresetPolicy || options.runCreationContinuation) && !options.context?.originalActionEnvelope) throw new ManagedMachineControllerError('admission_unavailable');
                const guestCli = options.acquisitionMode === 'resource-bound' ? undefined
                    : await readManagedGuestCliIdentity({ homeUrl: input.serverUrl, signal: options.signal,
                        ...(input.guestCliFetch ? { fetchImpl: input.guestCliFetch } : {}) });
                const admission = await executeManagedMachineAcquire({ host: 'native', guestCli, remotePayloadAvailable: true,
                    localPayloadAvailable: Boolean(readManagedGuestCliLocalPayloadRoot()),
                    admit: async () => {
                        const admit = async (presetPolicy?: Omit<ReturnType<typeof resolveMachineRetentionPolicyV1>, 'category'>,
                            preparation?: Readonly<{ provisioner: MachineProvisionerContributionV1; open: ManagedPresetDefinitionOpener }>) => {
                            if (options.acquisitionMode === 'resource-bound') {
                                options.context?.operationOwnerUpdate?.update({ progress: {
                                    phase: 'machines.managed.acquire', label: 'Creating sandbox',
                                } });
                            }
                            const admitted = await client.post('/v1/machines/managed/controller/admit', ManagedAdmissionInputV1Schema.parse({
                                input: computeInput, requestId: options.requestId, continuationPresent: hasCreationContinuation,
                                ...(options.acquisitionMode === 'resource-bound' ? { acquisitionMode: 'resource-bound',
                                    ...(options.reuseIdle ? { reuseIdle: true } : {}) } : {}),
                                ...(presetPolicy ? { presetPolicy } : {}),
                                ...(presetPolicy || options.runCreationContinuation ? { originalActionEnvelope: options.context?.originalActionEnvelope } : {}),
                            }), ManagedAdmissionOutputV1Schema);
                            client.assertConnection(admitted.machine);
                            return await openManagedPresetAdmissionWithHydrator({ input, acquisition, admission: admitted,
                                hydrator, signal: options.signal, ...(preparation ? { preparation } : {}) });
                        };
                        const machine = needsPresetPolicy && isManagedPresetAcquireInputV1(acquisition)
                            ? await withManagedPresetPolicy(input, acquisition, hydrator, delegated,
                                (policy, provisioner, open) => admit(policy, { provisioner, open }), options.signal,
                                options.acquisitionMode === 'resource-bound' ? options : undefined,
                                options.context?.externalActionExecutionAuthorization?.binding)
                            : await admit();
                        if (hasAttendedEnrollmentRequirement(machine.enrollmentIdentity)) {
                            throw new ManagedMachineControllerError('enrollment_attendance_required');
                        }
                        openedRequiresEnrollmentRead = machine.enrollmentIdentity?.kind === 'dedicatedDaemonUser';
                        const opaqueMachine = hydrator.structural(machine);
                        admittedExecutionOptions = isManagedOpaquePresetMachineV1(opaqueMachine)
                            ? withManagedOpaquePresetReview(options, { machine, opaqueMachine,
                                parent: { actionId: action, input: acquisition },
                                requestId: options.context?.actionRequestId ?? options.requestId })
                            : options;
                        return machine;
                    },
                    onAccepted: machine => {
                        const accepted: ManagedAcceptedV1 = { managedId: machine.id, operation: { operationId } };
                        options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: machine.id } });
                        options.context?.operationAcceptance?.accept(accepted);
                    },
                    run: machine => reconcileOnce({ input, options: admittedExecutionOptions, client, machine, action, hydrator }),
                });
                const accepted: ManagedAcceptedV1 = { managedId: admission.machine.id, operation: { operationId } };
                if (options.acquisitionMode === 'resource-bound') return accepted;
                let enrolled = admission.machine.machineSetup || hasCreationContinuation || openedRequiresEnrollmentRead
                    ? await client.row('current', client.correlation(admission.machine)) : admission.machine;
                client.assertConnection(enrolled);
                if (enrolled.machineSetup && !['succeeded', 'skipped'].includes(enrolled.machineSetup.state)) {
                    if (!enrolled.enrolledMachineId || !options.runEnvironmentSetup) throw new ManagedMachineControllerError('admission_unavailable');
                    const joined = enrolled;
                    try {
                        enrolled = hydrator.normalize(await options.runEnvironmentSetup({ machine: joined,
                            isCurrent: async () => !options.signal?.aborted }));
                    }
                    catch (error) {
                        if (!hasCreationContinuation || options.signal?.aborted) throw error;
                        const current = await client.readCurrent(joined);
                        if (!current) throw new ManagedMachineControllerError('intent_changed');
                        enrolled = current;
                    }
                    client.assertConnection(enrolled);
                    if (!enrolled.machineSetup || !['succeeded', 'skipped'].includes(enrolled.machineSetup.state)) {
                        if (!hasCreationContinuation || !options.subscribeEnvironmentSetupChanges) throw new ManagedMachineControllerError('machine_setup_setup_failed');
                        options.context?.operationProgress?.update({ phase: 'machineSetup', label: 'Waiting for environment setup recovery' });
                        let dirty = true;
                        let failed = false;
                        let wake: (() => void) | undefined;
                        const invalidate = () => { dirty = true; wake?.(); };
                        const abort = () => wake?.();
                        options.signal?.addEventListener('abort', abort);
                        let subscription: Awaited<ReturnType<NonNullable<ManagedMachineExecutionOptions['subscribeEnvironmentSetupChanges']>>> | undefined;
                        try {
                            subscription = await options.subscribeEnvironmentSetupChanges({ onChange: invalidate,
                                onError() { failed = true; invalidate(); } });
                            for (;;) {
                                if (options.signal?.aborted) throw new ManagedMachineControllerError('cancelled');
                                if (failed) throw new ManagedMachineControllerError('machine_setup_observation_failed');
                                dirty = false;
                                const current = await client.readCurrent(joined);
                                if (!current) throw new ManagedMachineControllerError('intent_changed');
                                enrolled = current;
                                if (current.machineSetup && ['succeeded', 'skipped'].includes(current.machineSetup.state)) break;
                                if (dirty) continue;
                                await new Promise<void>(resolve => {
                                    wake = resolve;
                                    if (dirty || failed || options.signal?.aborted) resolve();
                                });
                                wake = undefined;
                            }
                        } finally {
                            options.signal?.removeEventListener('abort', abort);
                            await subscription?.dispose();
                        }
                    }
                }
                if (runCreationContinuation) {
                    enrolled = await client.row('current', client.correlation(admission.machine));
                    client.assertConnection(enrolled);
                    if (!enrolled.enrolledMachineId) throw new ManagedMachineControllerError('enrollment_retired');
                    await runCreationContinuation({ machine: enrolled,
                        projectFiles: hydrator.readPresetDefinition(enrolled)?.projectFiles });
                }
                return accepted;
            }
            if (action === 'machines.managed.bootstrap.retry' || action === 'machines.managed.inspect') {
                const request = action === 'machines.managed.bootstrap.retry'
                    ? ManagedMachineActionInputSchemasV1['machines.managed.bootstrap.retry'].parse(parsed)
                    : null;
                const inspection = request ? null : ManagedMachineActionInputSchemasV1['machines.managed.inspect'].parse(parsed);
                const inspected = request ? null : options.policyMachine ?? unwrapManagedMachineReadV1(await client.post(managedMachineActionEndpointPathV1('machines.managed.get'),
                    { homeId: inspection!.homeId, managedId: inspection!.managedId }, ManagedGetOutputV1Schema));
                if (inspected) client.assertConnection(inspected);
                const retainedContext = await client.post('/v1/machines/managed/controller/context', {
                    homeId: request?.homeId ?? inspected!.homeId, managedId: request?.managedId ?? inspected!.id,
                    expectedIntentRevision: request?.expectedIntentRevision ?? inspected!.intentRevision, controller: input.controller,
                }, ManagedControllerContextOutputV1Schema);
                const retained = await normalizeManagedPresetCarrier(retainedContext, hydrator, options.signal);
                client.assertConnection(retained.machine);
                const recoveryBaseOptions = { ...options, requestId: retained.requestId };
                const opaqueMachine = hydrator.structural(retained.machine);
                const recoveryOptions = isManagedOpaquePresetMachineV1(opaqueMachine)
                    ? withManagedOpaquePresetReview(recoveryBaseOptions, { machine: retained.machine, opaqueMachine,
                        // Custody binds to the signed root this Inspect or retry runs
                        // under; Home's retained row request stays the currentness key.
                        parent: { actionId: action, input: request ?? inspection! }, requestId: options.requestId,
                    }) : recoveryBaseOptions;
                const recoveryClient = createManagedMachineControllerClient(input, recoveryOptions, action, hydrator);
                if (action === 'machines.managed.bootstrap.retry') {
                    const operationId = options.context?.operationAcceptance?.operationId;
                    if (!operationId) throw new ManagedMachineControllerError('admission_unavailable');
                    const accepted: ManagedAcceptedV1 = { managedId: retained.machine.id, operation: { operationId } };
                    options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: retained.machine.id } });
                    options.context?.operationAcceptance?.accept(accepted);
                    await reconcileOnce({ input, options: recoveryOptions, client: recoveryClient, machine: retained.machine, action, hydrator,
                        guestCli: readExternalActionManagedRetryGuestCliV1(options.context?.externalActionExecutionAuthorization?.binding) });
                    return accepted;
                }
                const result = retained.machine.submittedNativeEffect && !options.policyPurpose
                    ? { machine: await reconcileManagedIntent({ input, options: recoveryOptions, client: recoveryClient, machine: retained.machine, action }) }
                    : await reconcileManagedMachine({ input, options: recoveryOptions, client: recoveryClient, machine: retained.machine, action, hydrator });
                if (result === null) return null;
                if (typeof result !== 'object' || Array.isArray(result) || !('machine' in result)) {
                    throw new ManagedMachineControllerError('invalid_request');
                }
                const localMachine = ManagedMachineFullV1Schema.safeParse(result.machine);
                if (!localMachine.success) throw new ManagedMachineControllerError('invalid_request');
                const output = ManagedMachineActionOutputSchemasV1['machines.managed.inspect'].parse({ ...result,
                    machine: hydrator.structural(localMachine.data) });
                const requester = options.context?.externalActionExecutionAuthorization?.binding.accountId;
                if (inspection?.includeGuestDiagnostics) {
                    const machine = localMachine.data;
                    const provisioner = input.runtimeRegistry.contributes.machineProvisioners?.find(candidate =>
                        candidate.identity.pluginId === machine.launch.provider.pluginId
                        && candidate.identity.localId === machine.launch.provider.localId)?.definition;
                    output.guestDiagnostics = await readManagedGuestDiagnostics({ machine,
                        requesterAccountId: requester ?? readAccountIdFromToken(input.credentials.token) ?? undefined,
                        requestId: retained.requestId,
                        transport: provisioner?.bootstrapTransport,
                        channel: resolveManagedCliReleaseChannelSync({ argv: process.argv, invokedPath: process.argv[1], processEnv: process.env }).label,
                        signal: options.signal,
                        native: { exec: request => {
                            const native = createManagedNativeInvocation({ input, options: recoveryOptions, client: recoveryClient,
                                machine, action, includeGuestDiagnostics: true }, () => machine);
                            return createManagedNativeBootstrapIO({ resource: machine.resource! }, native.invoke).exec(request);
                        } },
                    });
                }
                // Reconciliation keeps its private custodian snapshot. Only the
                // public Action result crosses back to an exact creator.
                return projectNativeJsonValueForTransport(requester && requester !== output.machine.custodianAccountId
                    ? { ...output, machine: redactManagedMachineCredentialReferences(output.machine) } : output);
            }
            if (action in ManagedMachineActionOutputSchemasV1) {
                const output = ManagedMachineActionOutputSchemasV1[action as keyof typeof ManagedMachineActionOutputSchemasV1];
                return projectNativeJsonValueForTransport(await client.post<ManagedMachineActionOutputV1<keyof typeof ManagedMachineActionOutputSchemasV1>>(
                    managedMachineActionEndpointPathV1(action), parsed, output,
                ));
            }
            throw new ManagedMachineControllerError('invalid_request');
        },
    };
}

import axios from 'axios';
import { randomBytes } from 'node:crypto';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionIdsV1';
import { ManagedMachinePresetGetResultV1Schema, PresetMutationResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1,
    readMachineProvisionerSelectionForLaunchV1, readMachineProvisionerActionRolesV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { MachineProvisionerPreparationBuildResultV1Schema, MachineProvisionerPreparationInspectResultV1Schema,
    MachineProvisionerPreparationDestroyResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisionerPreparationSchemas';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createManagedOpaquePresetReviewedChildPortV1, bindManagedMachineRoleCredentials,
    projectManagedMachineRolePurposeBindingsV1, composeManagedMachinePresetPreparationBuildInputV1,
    settleManagedMachinePresetPreparationOperationV1, type ManagedMachinePresetPreparationRootV1 } from '@happier-dev/cli-common/machines/managed';
import { prepareManagedGuestCliBuildInput } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { prepareManagedGuestCliLocalBuildPayload } from '@happier-dev/cli-common/systemTasks/kinds/remoteFirstPartyPayloadInstaller';
import { createExternalActionRequesterServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createManagedPresetHydrator } from '@/machines/managed/presetHydration';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';
import { prepareMachineSetupPreparationV1 } from '@/machines/setup/prepareMachineSetupPreparation';
import { resolveRegistryConnectedAccountActionPurposeAuthorizations } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

type PrepareRequest = Parameters<NonNullable<ActionExecutorDeps['machinePresetPrepare']>>[0];

/** Installed host binding for the preset owner's existing finite operation. */
export async function prepareMachinePresetOnHost(request: PrepareRequest, host: Readonly<{
    homeId: string; machineId: string; installationId: string; serverBaseUrl: string;
    registry: ResolvedExecutablePluginRuntimeRegistry; isCurrent(): boolean;
    cancelAndWait?: ApiMachineClient['cancelAndWaitForActionOperation'];
}>) {
    const { input, context, signal } = request;
    const authorization = context.externalActionExecutionAuthorization;
    const requester = readRequesterAccountActionContext(authorization);
    const acceptance = context.operationAcceptance;
    const execute = context.executeHostReviewedChildAction;
    if (!authorization || authorization.binding.actionId !== MACHINE_PRESET_PREPARE_ACTION_ID_V1
        || !sameStrictJsonValue(authorization.binding.presetPreparationAdmission, input)
        || input.homeId !== host.homeId || input.machineId !== host.machineId
        || authorization.binding.machineId !== host.machineId
        || authorization.binding.installationId !== host.installationId
        || !requester || !acceptance || !execute) throw new ManagedMachineControllerError('admission_unavailable');
    // Stop withdraws new build work. The same admitted root still owns its
    // private cancellation status and native cleanup until this handler exits.
    const { signal: _operationSignal, ...admittedContext } = context;
    const headers = createExternalActionRequesterServerRequestHeaders(admittedContext);
    if (!headers) throw new ManagedMachineControllerError('credential_unavailable');
    const actionsSettings = context.actionsSettings
        ?? normalizeActionsSettingsV1(requester.accountSettingsContext.settings.actionsSettingsV1);
    const post = async (verb: 'get' | 'update', body: unknown) => {
        const path = `/v1/machines/presets/${verb}`;
        const requestSignal = signal?.aborted ? undefined : signal;
        const admittedHeaders = await headers({ method: 'POST', path, body, ...(requestSignal ? { signal: requestSignal } : {}) });
        if (!admittedHeaders) throw new ManagedMachineControllerError('admission_unavailable');
        return (await axios.post<unknown>(`${host.serverBaseUrl.replace(/\/+$/, '')}${path}`, body,
            { headers: admittedHeaders, ...(requestSignal ? { signal: requestSignal } : {}), validateStatus: () => true })).data;
    };
    const read = async () => {
        const result = ManagedMachinePresetGetResultV1Schema.parse(await post('get', { homeId: input.homeId, id: input.id }));
        if (result.kind !== 'found') throw new ManagedMachineControllerError(result.code);
        return result.preset;
    };
    const preset = await read();
    const hydrator = createManagedPresetHydrator({ credentials: requester.credentials, serverUrl: host.serverBaseUrl });
    const qualify = (launch: ManagedMachinePresetPreparationRootV1['launch']) => {
        const contribution = host.registry.contributes.machineProvisioners?.find(candidate =>
            candidate.pluginId === launch.provider.pluginId && candidate.definition.id === launch.provider.localId
            && candidate.definition.schemaVersion === launch.schemaVersion);
        if (!contribution?.definition.preparation) throw new ManagedMachineControllerError('provider_unavailable');
        return { launch, provisioner: contribution.definition };
    };
    const parent = { actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1, input };
    const invoke = async ({ launch, provisioner }: ReturnType<typeof qualify>,
        role: ReturnType<typeof readMachineProvisionerActionRolesV1>[number]['role'], nativeInput: unknown) => {
        const localId = readMachineProvisionerActionRolesV1(provisioner).find(binding => binding.role === role)?.action;
        if (!localId) throw new ManagedMachineControllerError('provider_unavailable');
        const identity = { pluginId: launch.provider.pluginId, localId };
        const authorizations = resolveRegistryConnectedAccountActionPurposeAuthorizations({ registry: host.registry.contributes,
            qualifiedActionId: buildQualifiedPluginContributionKey(identity) });
        if (!authorizations) throw new ManagedMachineControllerError('provider_unavailable');
        const selected = bindManagedMachineRoleCredentials({ authorizations, provider: launch.provider,
            credentials: launch.credentials, qualification: { descriptor: provisioner, launch: launch.choices } });
        const cleanup = role === 'preparationDestroy' || role === 'preparationInspect' && signal?.aborted === true;
        const invocationContext = cleanup ? admittedContext : context;
        const childContext = { ...invocationContext, actionsSettings, invocationServices: { ...context.invocationServices,
            connectedAccountPurposeBinding: { identity, operationId: acceptance.operationId,
                purposes: selected.map(item => item.purpose), purposeBindings: projectManagedMachineRolePurposeBindingsV1(selected),
                isCurrent: () => host.isCurrent() && (cleanup || !signal?.aborted) } } };
        const port = createManagedOpaquePresetReviewedChildPortV1({ parent, context: childContext,
            launch, provisioner, localId, role, execute: (body, next) => execute('action.invoke', {
                action: identity, input: projectNativeJsonValueForTransport(body),
            }, next) });
        if (!port) throw new ManagedMachineControllerError('admission_unavailable');
        const result = await port.invoke({ action: identity, role, input: projectNativeJsonValueForTransport(nativeInput),
            invocationServices: childContext.invocationServices });
        if (!result.ok) throw ManagedMachineControllerError.fromActionFailure(result, MACHINE_PRESET_PREPARE_ACTION_ID_V1);
        return result.result;
    };
    const accepted = { status: 'accepted' as const, operationId: acceptance.operationId, machineId: host.machineId };
    let acceptedOnce = false;
    const accept = () => { if (!acceptedOnce) { acceptedOnce = true; acceptance.accept(accepted); } };
    const cancelAndWait = host.cancelAndWait;
    const run = async (custody: Parameters<typeof settleManagedMachinePresetPreparationOperationV1>[0]['custody']) => {
        let firstRead = true;
        const result = await settleManagedMachinePresetPreparationOperationV1({ operationId: acceptance.operationId,
            expectedRevision: input.expectedRevision, custody, ...(signal ? { signal } : {}),
            ...(cancelAndWait ? { stopIncumbentBuild: async (operationId: string) => {
                const retirement = await cancelAndWait({ accountId: authorization.binding.accountId,
                    machineId: host.machineId }, operationId);
                return retirement.kind === 'requested' || retirement.kind === 'already_settled';
            } } : {}),
            storage: { read: async () => { if (firstRead) { firstRead = false; return preset; } return await read(); },
                compareAndSwap: async update => PresetMutationResultV1Schema.parse(await post('update', {
                    homeId: input.homeId, id: input.id, expectedRevision: update.expectedRevision,
                    patch: { content: update.content, recipients: update.recipients },
                })) },
            composeBuild: async capturedContent => {
                if (!capturedContent.launch) throw new ManagedMachineControllerError('invalid_request');
                const qualified = qualify(capturedContent.launch);
                const { launch, provisioner } = qualified;
                const optionsAction = provisioner.actions.options;
                const action = optionsAction && host.registry.contributes.actions.find(candidate =>
                    candidate.pluginId === launch.provider.pluginId && candidate.definition.id === optionsAction);
                if (!optionsAction || !action) throw new ManagedMachineControllerError('provider_unavailable');
                const selectors = createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(action.definition.inputSchema)).parse(launch.choices);
                const options = MachineProvisionerOptionsResultV1Schema.parse(await invoke(qualified, 'options', selectors));
                const projection = projectMachineProvisionerSelectionV1({ options, launchSchema: provisioner.launchSchema,
                    selection: readMachineProvisionerSelectionForLaunchV1(options, launch.choices) });
                if (projection.kind !== 'ready' || !projection.nativeFacts.preparationGuest) throw new ManagedMachineControllerError('provider_unavailable');
                const guest = projection.nativeFacts.preparationGuest;
                const cli = await prepareManagedGuestCliBuildInput({ homeUrl: host.serverBaseUrl,
                    target: guest.target, remoteHomeDir: guest.remoteHomeDir, prepareLocalPayload: prepareManagedGuestCliLocalBuildPayload,
                    ...(signal ? { signal } : {}) });
                const setup = capturedContent.setup ? prepareMachineSetupPreparationV1({ operationId: acceptance.operationId,
                    setup: capturedContent.setup, recipes: (host.registry.contributes.machineRecipes ?? []).flatMap(entry =>
                        entry.pluginId ? [{ pluginId: entry.pluginId, definition: entry.definition }] : []) }) : undefined;
                return composeManagedMachinePresetPreparationBuildInputV1({ operationId: acceptance.operationId, launch, cli,
                    ...(setup ? { setup } : {}) });
            },
            native: {
                build: async (body, root) => { accept(); return MachineProvisionerPreparationBuildResultV1Schema.parse(await invoke(qualify(root.launch), 'preparationBuild', body)); },
                inspect: async (body, root) => { accept(); return MachineProvisionerPreparationInspectResultV1Schema.parse(await invoke(qualify(root.launch), 'preparationInspect', body)); },
                destroy: async (body, root) => MachineProvisionerPreparationDestroyResultV1Schema.parse(await invoke(qualify(root.launch), 'preparationDestroy', body)),
            },
        });
        if (result.kind !== 'ready') throw new ManagedMachineControllerError('code' in result ? result.code : result.kind === 'conflict' ? 'request_conflict' : 'cancelled');
        accept();
        return accepted;
    };
    return preset.contentEncryptionMode === 'plain' ? await run({ mode: 'plain' })
        : await hydrator.withE2eeAccountKey(account => run({ mode: 'e2ee', ...account, randomBytes }), signal);
}

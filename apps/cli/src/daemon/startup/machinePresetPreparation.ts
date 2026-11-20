import { resolveRetainedMachineProvisioner } from '@happier-dev/cli-common/machines/managed/provisioners';
import axios from 'axios';
import { randomBytes } from 'node:crypto';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionIdsV1';
import { ManagedMachinePresetGetResultV1Schema, PresetMutationResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { openManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type { ManagedMachinePresetPreparationBindingV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationV1';
import { MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1,
    readMachineProvisionerSelectionForLaunchV1, readMachineProvisionerActionRolesV1,
    type MachineProvisionerRoleV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { MachineProvisionerPreparationBuildResultV1Schema, MachineProvisionerPreparationInspectResultV1Schema,
    MachineProvisionerPreparationDestroyResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisionerPreparationSchemas';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { readPluginActionFailureHandlerInvocation } from '@happier-dev/protocol/plugins/actions/invocation';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createManagedOpaquePresetReviewedChildPortV1, bindManagedMachineRoleCredentials,
    projectManagedMachineRolePurposeBindingsV1, composeManagedMachinePresetPreparationBuildInputV1,
    settleManagedMachinePresetPreparationOperationV1, type ManagedMachinePresetPreparationRootV1 } from '@happier-dev/cli-common/machines/managed';
import { captureManagedMachineRoleCredentialConfigurationsV1 } from '@happier-dev/cli-common/machines/managed/reconcile';
import { prepareManagedGuestCliBuildInput, resolveManagedGuestCliBuildIdentity } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { prepareManagedGuestCliLocalBuildPayload, readManagedGuestCliLocalBuildPayloadMetadata } from '@happier-dev/cli-common/systemTasks/kinds/remoteFirstPartyPayloadInstaller';
import { createExternalActionRequesterServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createManagedPresetHydrator } from '@/machines/managed/presetHydration';
import { ManagedMachineControllerError, ManagedMachineNativeEffectGuardRefusal } from '@/machines/managed/controllerErrors';
import { prepareMachineSetupPreparationV1 } from '@/machines/setup/prepareMachineSetupPreparation';
import { createManagedBootstrapTaskRunner } from '@/machines/managed/enrollmentTask';
import { runPreparedPresetSshHostTrust } from '@/machines/managed/enrollmentSshTrust';
import type { ManagedMachineBootstrapPromptV1 } from '@happier-dev/protocol/actions/operations/v1';
import { resolveRegistryConnectedAccountActionPurposeAuthorizations } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';

type PrepareRequest = Parameters<NonNullable<ActionExecutorDeps['machinePresetPrepare']>>[0];

/** Installed host binding for the preset owner's existing finite operation. */
export async function prepareMachinePresetOnHost(request: PrepareRequest, host: Readonly<{
    homeId: string; machineId: string; installationId: string; serverBaseUrl: string;
    registry: ResolvedExecutablePluginRuntimeRegistry; isCurrent(): boolean;
    readCredentialConfigurationRevision: ConnectedAccountPurposeBindingOwner['readCredentialConfigurationRevision'];
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
        const contribution = resolveRetainedMachineProvisioner(host.registry.contributes.machineProvisioners, launch);
        if (!contribution?.definition.preparation) throw new ManagedMachineControllerError('provider_unavailable');
        return { launch, provisioner: contribution.definition };
    };
    const parent = { actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1, input };
    const managedSshHostTrust = async (carrier: Parameters<typeof runPreparedPresetSshHostTrust>[0]['carrier']) => {
        let taskId: string | undefined;
        let prompt: ManagedMachineBootstrapPromptV1 | null = null;
        const publish = () => {
            if (!taskId) return;
            context.operationOwnerUpdate?.update({ domainRef: { kind: 'systemTask', id: taskId,
                taskKind: 'remote.ssh.bootstrapMachine.v1', ...(prompt ? { prompt } : {}) } });
        };
        const runner = createManagedBootstrapTaskRunner({ ...(signal ? { signal } : {}),
            onTask: task => { taskId = task.taskId; publish(); },
            onPrompt: question => { prompt = question; publish(); },
            onEvent: event => {
                if (event.type === 'progress' && event.message) context.operationOwnerUpdate?.update({ progress: {
                    ...(event.stepId ? { phase: event.stepId } : {}), label: event.message,
                } });
            },
        });
        await runner.run({ run: async task => {
            task.emit({ type: 'progress', stepId: 'ssh.trust', message: 'Verifying SSH host trust' });
            await runPreparedPresetSshHostTrust({ correlation: { homeId: input.homeId, presetId: input.id,
                operationId: acceptance.operationId }, carrier, signal: task.signal, prompt: task.prompt });
            return { trusted: true };
        } });
    };
    const bindRole = ({ launch, provisioner }: ReturnType<typeof qualify>,
        role: ReturnType<typeof readMachineProvisionerActionRolesV1>[number]['role']) => {
        const localId = readMachineProvisionerActionRolesV1(provisioner).find(binding => binding.role === role)?.action;
        if (!localId) throw new ManagedMachineControllerError('provider_unavailable');
        const identity = { pluginId: launch.provider.pluginId, localId };
        const authorizations = resolveRegistryConnectedAccountActionPurposeAuthorizations({ registry: host.registry.contributes,
            qualifiedActionId: buildQualifiedPluginContributionKey(identity) });
        if (!authorizations) throw new ManagedMachineControllerError('provider_unavailable');
        const selected = bindManagedMachineRoleCredentials({ authorizations, provider: launch.provider,
            credentials: launch.credentials, qualification: { descriptor: provisioner, launch: launch.choices } });
        return { identity, localId, selected };
    };
    const invoke = async (qualified: ReturnType<typeof qualify>,
        role: ReturnType<typeof readMachineProvisionerActionRolesV1>[number]['role'], nativeInput: unknown,
        credentialConfigurations: ManagedMachinePresetPreparationBindingV1['credentialConfigurations']) => {
        const { launch, provisioner } = qualified;
        const { identity, localId, selected } = bindRole(qualified, role);
        const cleanup = role === 'preparationDestroy' || role === 'preparationInspect' && signal?.aborted === true;
        const invocationContext = cleanup ? admittedContext : context;
        const childContext = { ...invocationContext, actionsSettings, invocationServices: { ...context.invocationServices,
            managedSshHostTrust,
            connectedAccountPurposeBinding: { identity, operationId: acceptance.operationId,
                purposes: selected.map(item => item.purpose), purposeBindings: projectManagedMachineRolePurposeBindingsV1(selected),
                managedOperation: { role, credentialConfigurations,
                    isCurrent: (currentRole: MachineProvisionerRoleV1) => currentRole === role && host.isCurrent() && (cleanup || !signal?.aborted) },
                isCurrent: () => host.isCurrent() && (cleanup || !signal?.aborted) } } };
        const port = createManagedOpaquePresetReviewedChildPortV1({ parent, context: childContext,
            launch, provisioner, localId, role, execute: (body, next) => execute('action.invoke', {
                action: identity, input: projectNativeJsonValueForTransport(body),
            }, next) });
        if (!port) throw new ManagedMachineControllerError('admission_unavailable');
        const result = await port.invoke({ action: identity, role, input: projectNativeJsonValueForTransport(nativeInput),
            invocationServices: childContext.invocationServices });
        if (!result.ok) {
            const ErrorClass = readPluginActionFailureHandlerInvocation({ code: result.errorCode, message: result.error,
                data: result.details }) === 'notStarted' ? ManagedMachineNativeEffectGuardRefusal : ManagedMachineControllerError;
            throw ErrorClass.fromActionFailure(result, MACHINE_PRESET_PREPARE_ACTION_ID_V1, identity);
        }
        return result.result;
    };
    const accepted = { status: 'accepted' as const, operationId: acceptance.operationId, machineId: host.machineId };
    let acceptedOnce = false;
    const accept = () => { if (!acceptedOnce) { acceptedOnce = true; acceptance.accept(accepted); } };
    const run = async (custody: Parameters<typeof settleManagedMachinePresetPreparationOperationV1>[0]['custody']) => {
        const opening = { presetId: preset.id, content: preset.content };
        const content = custody.mode === 'plain' ? openManagedMachinePresetContentV1({ ...opening, mode: 'plain' })
            : openManagedMachinePresetContentV1({ ...opening, ...custody, recipients: preset.recipients });
        if (!content?.launch) throw new ManagedMachineControllerError('credential_unavailable');
        const credentialConfigurations = await captureManagedMachineRoleCredentialConfigurationsV1({
            authorizations: bindRole(qualify(content.launch), 'preparationBuild').selected,
            readCredentialConfigurationRevision: host.readCredentialConfigurationRevision,
            signal: signal ?? new AbortController().signal,
        });
        const readGuest = async (launch: ManagedMachinePresetPreparationRootV1['launch']) => {
            const qualified = qualify(launch);
            const { provisioner } = qualified;
            const optionsAction = provisioner.actions.options;
            const action = optionsAction ? host.registry.contributes.actions.find(candidate =>
                candidate.pluginId === launch.provider.pluginId && candidate.definition.id === optionsAction) : undefined;
            if (!optionsAction || !action?.definition.inputSchema) throw new ManagedMachineControllerError('provider_unavailable');
            const selectors = createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(action.definition.inputSchema)).parse(launch.choices);
            const options = MachineProvisionerOptionsResultV1Schema.parse(await invoke(qualified, 'options', selectors, credentialConfigurations));
            const projection = projectMachineProvisionerSelectionV1({ options, launchSchema: provisioner.launchSchema,
                selection: readMachineProvisionerSelectionForLaunchV1(options, launch.choices) });
            if (projection.kind !== 'ready' || !projection.nativeFacts.preparationGuest) throw new ManagedMachineControllerError('provider_unavailable');
            return {
                ...projection.nativeFacts.preparationGuest,
                ...(provisioner.preparation?.cliPayloadDelivery === 'guest-download' ? { guestDownload: { homeId: host.homeId } } : {}),
            };
        };
        // Recovery needs the current supplier identity, not a newly archived payload.
        // Reuse this selected guest if the preset owner decides a rebuild is needed.
        const recoveryGuest = content.prepared?.status === 'building' ? await readGuest(content.launch) : undefined;
        const cliIdentity = recoveryGuest ? (await resolveManagedGuestCliBuildIdentity({ homeUrl: host.serverBaseUrl,
            ...recoveryGuest, readLocalPayloadMetadata: readManagedGuestCliLocalBuildPayloadMetadata,
            ...(signal ? { signal } : {}) })).identity : undefined;
        // An incumbent image belongs to the connected configuration it was built with, as Archive cleans it.
        const ownedConfigurations = (root: ManagedMachinePresetPreparationRootV1) => content.prepared?.operationId === root.operationId
            ? content.prepared.binding.credentialConfigurations : credentialConfigurations;
        let firstRead = true;
        const result = await settleManagedMachinePresetPreparationOperationV1({ operationId: acceptance.operationId,
            expectedRevision: input.expectedRevision, machineId: host.machineId, custody, credentialConfigurations,
            readDestroyExecution: async launch => {
                const destroyId = qualify(launch).provisioner.preparation?.actions.destroy;
                return { execution: host.registry.contributes.actions.find(candidate => candidate.pluginId === launch.provider.pluginId
                    && candidate.definition.id === destroyId)?.definition.execution };
            },
            onProgress: progress => context.operationOwnerUpdate?.update({ progress }),
            ...(cliIdentity === undefined ? {} : { cliIdentity }), ...(signal ? { signal } : {}),
            storage: { read: async () => { if (firstRead) { firstRead = false; return preset; } return await read(); },
                compareAndSwap: async update => PresetMutationResultV1Schema.parse(await post('update', {
                    homeId: input.homeId, id: input.id, expectedRevision: update.expectedRevision,
                    patch: { content: update.content, recipients: update.recipients },
                })) },
            composeBuild: async capturedContent => {
                if (!capturedContent.launch) throw new ManagedMachineControllerError('invalid_request');
                const launch = capturedContent.launch;
                const guest = recoveryGuest ?? await readGuest(launch);
                const cli = await prepareManagedGuestCliBuildInput({ homeUrl: host.serverBaseUrl,
                    ...guest, prepareLocalPayload: prepareManagedGuestCliLocalBuildPayload,
                    ...(signal ? { signal } : {}) });
                const setup = capturedContent.setup ? prepareMachineSetupPreparationV1({ operationId: acceptance.operationId,
                    setup: capturedContent.setup, recipes: (host.registry.contributes.machineRecipes ?? []).flatMap(entry =>
                        entry.pluginId ? [{ pluginId: entry.pluginId, definition: entry.definition }] : []) }) : undefined;
                return composeManagedMachinePresetPreparationBuildInputV1({ operationId: acceptance.operationId, launch, cli,
                    ...(setup ? { setup } : {}) });
            },
            native: {
                build: async (body, root) => { accept(); return MachineProvisionerPreparationBuildResultV1Schema.parse(await invoke(qualify(root.launch), 'preparationBuild', body, credentialConfigurations)); },
                inspect: async (body, root) => { accept(); return MachineProvisionerPreparationInspectResultV1Schema.parse(await invoke(qualify(root.launch), 'preparationInspect', body, ownedConfigurations(root))); },
                destroy: async (body, root) => MachineProvisionerPreparationDestroyResultV1Schema.parse(await invoke(qualify(root.launch), 'preparationDestroy', body, ownedConfigurations(root))),
            },
        });
        if (result.kind !== 'ready') {
            const prepared = 'prepared' in result ? result.prepared : undefined;
            const code = 'code' in result ? result.code : prepared?.code
                ?? (result.kind === 'conflict' ? 'request_conflict' : 'cancelled');
            throw new ManagedMachineControllerError(code, undefined, prepared?.nativeCause
                ? { kind: 'managedNative', nativeCause: prepared.nativeCause } : undefined);
        }
        accept();
        return accepted;
    };
    return preset.contentEncryptionMode === 'plain' ? await run({ mode: 'plain' })
        : await hydrator.withE2eeAccountKey(account => run({ mode: 'e2ee', ...account, randomBytes }), signal);
}

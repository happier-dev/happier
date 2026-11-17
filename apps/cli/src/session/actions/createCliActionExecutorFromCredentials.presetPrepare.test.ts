import { afterEach, expect, it, vi } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { bindPresentUserActionConfirmationV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionIdsV1';
import { createDaemonManagedMachineActionAdapter } from '@/daemon/startup/managedMachineActionAdapter';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

afterEach(() => vi.restoreAllMocks());

it('preserves the installed Prepare owner refusal through the credentialed daemon executor', async () => {
    const actionId = MACHINE_PRESET_PREPARE_ACTION_ID_V1;
    const input = { homeId: 'srv_home', id: 'preset', expectedRevision: 1, machineId: 'controller' };
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    // The actual native owner has no admitted provider authority. Its typed
    // refusal must survive composition; omitting the port returns unsupported_action.
    const managed = createDaemonManagedMachineActionAdapter({ credentials, machineId: target.machineId,
        serverId: 'home', serverBaseUrl: 'https://prepare.test',
        acquireRuntimeRegistryLease: acquireAuthoritativePluginRuntimeRegistryLease });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-root', binding: {
        accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
        accountEncryptionMode: 'plain', serverIdentityId: input.homeId, machineId: target.machineId,
        installationId: 'installation', actionId, requestId: 'prepare', target, presetPreparationAdmission: input,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'prepare', target, input }),
    } });
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'home',
        serverIdentityId: input.homeId, serverApiUrl: 'https://prepare.test', pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: AccountSettingsSchema.parse({}) }),
        machinePresetPrepare: managed.preparePreset });
    const context = bindPresentUserActionConfirmationV1(actionId, input, { surface: 'rpc', authority: 'present_user',
        actionCaller: { kind: 'host' }, runtimeAccountId: 'account', actionRequestId: 'prepare',
        serverId: 'home', serverIdentityId: input.homeId, externalActionTarget: target,
        externalActionExecutionAuthorization: authorization,
        originalActionEnvelope: { v: 1, requestId: 'prepare', target, input } });
    const result = await executor.execute(actionId, input, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'action_failed',
        failureCause: { errorCode: 'admission_unavailable' } });
});

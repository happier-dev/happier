import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { createPluginAccountActionSettingsService } from '@happier-dev/cli-common/plugins/registration/accountActionSettings';
import { PLUGIN_ACCOUNT_STORAGE_UNAVAILABLE_CODE } from '../context/storage';

/** The same restricted Account context for Actions and in-process deployment callbacks. */
export function createAccountInvocationContext(context: Pick<PluginInvocationContext,
    'plugin' | 'contribution' | 'surface' | 'invokedAtMs' | 'signal' | 'requestId' | 'caller' | 'sessionTargetsV1' | 'services'>,
    accountScope?: PluginAccountActionContext['accountScope']): PluginAccountActionContext {
    return Object.freeze({
        plugin: context.plugin, contribution: context.contribution, surface: context.surface,
        invokedAtMs: context.invokedAtMs, signal: context.signal,
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
        ...(context.caller ? { caller: context.caller } : {}),
        ...(accountScope ? { accountScope } : {}),
        ...(context.sessionTargetsV1 ? { sessionTargetsV1: context.sessionTargetsV1 } : {}),
        services: Object.freeze({
            http: context.services.http,
            secrets: context.services.secrets,
            machineProvisioners: context.services.machineProvisioners,
            ...(context.services.machineConnectorSecrets ? { machineConnectorSecrets: context.services.machineConnectorSecrets } : {}),
            connectedAccounts: context.services.connectedAccounts,
            storage: Object.freeze({ get account() {
                const accountStorage = context.services.storage.account;
                if (!accountStorage) throw new PluginError({ code: PLUGIN_ACCOUNT_STORAGE_UNAVAILABLE_CODE, message: 'Account storage is unavailable' });
                return accountStorage;
            } }),
            actions: Object.freeze({ execute: context.services.actions.execute, observe: context.services.actions.observe,
                executeAdmittedTargetedOperation: context.services.actions.executeAdmittedTargetedOperation,
                observeAdmittedTargetedOperation: context.services.actions.observeAdmittedTargetedOperation }),
            targetedContributions: context.services.targetedContributions,
            settings: createPluginAccountActionSettingsService(context.services.settings),
        }),
    }) satisfies PluginAccountActionContext;
}

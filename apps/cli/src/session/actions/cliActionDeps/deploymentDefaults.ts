import { DeploymentEnvironmentGetResultV1Schema, type ActionExecutorContext, type ActionExecuteFailure,
    type DeploymentEnvironmentGetResultV1, type DeploymentEnvironmentUpdateInputV1 } from '@happier-dev/protocol';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { prepareDeploymentEnvironmentDefaultsForHost } from '@/deployments/readCreationDefaultsForHost';

type DefaultsHost = Parameters<typeof prepareDeploymentEnvironmentDefaultsForHost>[1];

/** Safe mounted previews need private defaults, rather than a Home storage PATCH. */
export async function prepareCliDeploymentAlertDefaults(input: DeploymentEnvironmentUpdateInputV1,
    context: ActionExecutorContext, host: Omit<DefaultsHost, 'accountId' | 'expectedScopeKey' | 'readAccountSnapshot'> & Readonly<{
        credentials: StoredCredentials;
        savedSecretOperationContext?: SavedSecretOperationContextV1;
        readEnvironment(): Promise<DeploymentEnvironmentGetResultV1 | ActionExecuteFailure>;
    }>) {
    return runWithServerHttpBaseUrl(host.serverHttpBaseUrl, async () => {
        const loaded = await host.readEnvironment();
        if ('errorCode' in loaded) return loaded;
        const environment = DeploymentEnvironmentGetResultV1Schema.parse(loaded);
        if (!environment.ok) return environment;
        const accountId = readAccountIdFromToken(host.credentials.token);
        if (!accountId) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
        return prepareDeploymentEnvironmentDefaultsForHost({ input, environment, context }, {
            ...host, accountId, expectedScopeKey: resolveAccountSettingsScopeKey(host.credentials),
            async assertCurrent(readContext) {
                await host.assertCurrent(readContext);
                if (host.savedSecretOperationContext && !await host.savedSecretOperationContext.isCurrent(readContext.signal))
                    throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' });
            },
            async readAccountSnapshot() {
                if (host.savedSecretOperationContext) return host.savedSecretOperationContext.readSnapshot();
                const { bootstrapAccountSettingsContext } = await import('@/settings/accountSettings/bootstrapAccountSettingsContext');
                return bootstrapAccountSettingsContext({ credentials: host.credentials, mode: 'blocking',
                    publication: 'invocation', refresh: 'force', honorAccountSettingsModeEnv: false });
            },
        });
    });
}

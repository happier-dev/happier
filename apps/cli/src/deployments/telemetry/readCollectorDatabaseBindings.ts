import { DatabaseConnectionUrlError, parseDatabaseConnectionUrl } from '@happier-dev/databases';
import type { DeploymentTelemetryServiceV1 } from '@happier-dev/plugin-sdk';
import { projectAutomationDatabaseFindingSubjectV1 } from '@happier-dev/plugin-sdk/events';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { readSavedSecretMaterializerForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { materializeSavedSecretReferenceBinding } from '@/settings/secrets/secretReferenceOverlay';
import type { DeploymentTargetRoleAdmissionHost } from '../targets/admitDeploymentTargetRoleForHost';

type BindingSource = NonNullable<DeploymentTelemetryServiceV1['databaseBindings']>;

/** Use ordinary Account admission and release the opened Saved Secret with this one refresh. */
export async function readCollectorDatabaseBindings(host: DeploymentTargetRoleAdmissionHost, environmentId: string,
    signal: AbortSignal): ReturnType<BindingSource['read']> {
    const { credentials, serverId, serverHttpBaseUrl } = host;
    const context = { signal };
    const { content, targetLinks, savedSecretRevisions } = await host.readEnvironment({ environmentId, context });
    const admitted = new Map(savedSecretRevisions?.map(({ resourceId, revision }) => [formatSharedSavedSecretRefV1(resourceId), revision]));
    const candidates = content.bindings.flatMap(binding => {
        if (binding.purpose !== 'dataRole' || binding.role !== 'write') return [];
        const revision = admitted.get(binding.source.ref);
        if (revision === undefined || revision !== binding.source.resourceRevision) return [];
        if ('service' in binding) {
            return content.template?.data?.some(data => data.service === binding.service) ? [binding] : [];
        }
        return targetLinks.some(({ targetLink }) => targetLink.id === binding.targetLinkId && targetLink.role === 'data'
            && targetLink.state !== 'detached' && targetLink.deletedAtMs === undefined && targetLink.detachedAtMs === undefined) ? [binding] : [];
    });
    if (!candidates.length) return [];
    return runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
        const expectedScopeKey = resolveAccountSettingsScopeKey(credentials);
        const active = getActiveAccountSettingsSnapshot();
        const snapshot = active?.scopeKey === expectedScopeKey ? active : await bootstrapAccountSettingsContext({
            credentials, signal, mode: 'blocking', publication: 'invocation', honorAccountSettingsModeEnv: false,
        });
        if (!expectedScopeKey || snapshot.scopeKey !== expectedScopeKey) return [];
        const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl,
            snapshot: { ...snapshot, savedSecretResources: [] }, async isCurrent() { await host.assertCurrent(context); return true; } });
        const references = candidates.map(({ source }) => ({ ref: source.ref, revision: source.resourceRevision }));
        try {
            const { materializer } = await readSavedSecretMaterializerForOperation({ expectedScopeKey, operationContext, signal,
                references, sourceKind: 'inline' });
            return candidates.flatMap((binding, index) => {
                const value = materializeSavedSecretReferenceBinding({ requirementName: 'bound database endpoint',
                    binding: references[index]!, materializer, exactReference: true });
                if (!value) return [];
                try {
                    const { engine, hostname, port, database } = parseDatabaseConnectionUrl(value);
                    if (engine === 'sqlite' || !hostname || !database) return [];
                    const subject = projectAutomationDatabaseFindingSubjectV1(serverId, { kind: 'environment_binding', environmentId,
                        address: 'service' in binding ? { service: binding.service } : { targetLinkId: binding.targetLinkId } });
                    return [{ engine, hostname, port: port ?? (engine === 'postgresql' ? 5432 : 3306), database, subject }];
                } catch (error) {
                    if (error instanceof DatabaseConnectionUrlError) return [];
                    throw error;
                }
            });
        } finally { operationContext.withdrawCatalog(); }
    });
}

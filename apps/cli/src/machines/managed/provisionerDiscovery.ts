import { createConnectedAccountActionTeamResourceCatalogReader } from '@/daemon/connectedServices/purposeBindings/actionTeamResourceCatalog';
import { executeManagedProvisionerDiscovery, projectAccountManagedProvisioners, type ManagedProvisionerDiscoveryEntry } from '@happier-dev/cli-common/machines/managed/provisioners';
import { listConnectedAccountActionFormOptions, projectConnectedAccountHostAccessScopes } from '@happier-dev/cli-common/connectedAccounts';
import type { ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { resolvePluginActionConnectedAccountUseRequestsV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { readCurrentAccountPluginExecutionDeclarations } from '@/plugins/runtime/accountPluginActivationSource';
import { listQualifiedConnectedAccountsV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import type { ActionExecutorDeps } from '@happier-dev/protocol';

/** Account discovery shares the UI's declaration and metadata owners; it never activates providers. */
export async function executeCliManagedProvisionerList(input: Readonly<{
    value: ManagedMachineActionInputV1<'machines.provisioners.list'>;
    credentials: StoredCredentials; serverUrl: string; signal?: AbortSignal;
    homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
}>) {
    const selected = await readCurrentAccountPluginExecutionDeclarations({ ...input,
        family: 'machineProvisioners', pluginId: input.value.contribution?.pluginId });
    if (selected.kind !== 'available') return { ok: false as const, errorCode: selected.code, error: selected.code };
    return executeManagedProvisionerDiscovery({ actionId: 'machines.provisioners.list', value: input.value,
        entries: projectAccountManagedProvisioners(selected.declarations),
        // Broad chooser discovery needs descriptors only. Credential metadata is
        // demanded by the exact provider form, through the shared inventory owner.
        ...(input.value.contribution ? { readCredentialPurposes: async (entry: ManagedProvisionerDiscoveryEntry) => {
            const selection = selected.declarations.find(candidate => candidate.manifest.id === entry.contribution.pluginId)!;
            const requests = resolvePluginActionConnectedAccountUseRequestsV2(selection.manifest, entry.descriptor.actions.acquire);
            if (!requests) return undefined;
            const scopes = projectConnectedAccountHostAccessScopes(entry.contribution.pluginId, requests);
            const signal = input.signal ?? new AbortController().signal;
            return Promise.all(scopes.map(async scope => ({ purpose: { consumer: entry.contribution, purpose: scope.purpose },
                options: [...await listConnectedAccountActionFormOptions({ available: true,
                    listTeamResources: createConnectedAccountActionTeamResourceCatalogReader({ homeDomainAction: input.homeDomainAction }),
                    resolveService: async (service, requestSignal) => {
                        let manifest = selection.manifest;
                        if (service.pluginId !== manifest.id) {
                            const source = await readCurrentAccountPluginExecutionDeclarations({ credentials: input.credentials,
                                serverUrl: input.serverUrl, family: 'connectedAccountDescriptors', pluginId: service.pluginId, signal: requestSignal });
                            if (source.kind !== 'available' || !source.declarations[0]) return null;
                            manifest = source.declarations[0].manifest;
                        }
                        const descriptor = manifest?.contributes.connectedAccountDescriptors?.find(candidate => candidate.id === service.localId);
                        return descriptor ? { service, authentication: descriptor.authentication } : null;
                    },
                    listAccounts: async (service, requestSignal) => runWithServerHttpBaseUrl(input.serverUrl, async () =>
                        (await listQualifiedConnectedAccountsV4({ token: input.credentials.token, service, signal: requestSignal })).accounts),
                }, { serviceRefs: scope.serviceRefs, signal })],
            })));
        } } : {}),
    });
}

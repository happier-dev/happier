import { resolveAccountSettingsPluginSecretBinding, listAccountSettingsVoiceCredentialSecretRefs } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { canonicalizeProviderContributionKeyV1 } from '@happier-dev/protocol/providers/contribution-identity';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { listProviderConnectionsCatalogSavedSecretRefsV1, type ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { listConnectedConfigurationCatalogSavedSecretRefsV1, type ConnectedConfigurationCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

export type ConnectSheetKeyBindingTarget =
    | Readonly<{ kind: 'provider'; contributionKey: string; slot: string }>
    | Readonly<{ kind: 'service'; service: PluginContributionIdentityV1; modeId: string; fieldId: string }>
    | Readonly<{ kind: 'voice'; contribution: PluginContributionIdentityV1; slot: string }>
    | Readonly<{ kind: 'plugin'; pluginId: string; localId: string }>;

/** Filter already-admitted metadata through each catalog's reference owner. */
export function listConnectSheetKeyBindingRefs(input: Readonly<{
    target: ConnectSheetKeyBindingTarget;
    settings?: Readonly<Record<string, unknown>>;
    providerConnections?: ProviderConnectionsCatalogV1 | null;
    connectedConfigurations?: ConnectedConfigurationCatalogV1 | null;
}>): readonly string[] {
    const { target } = input;
    if (target.kind === 'voice') return listAccountSettingsVoiceCredentialSecretRefs(input.settings ?? {},
        { contribution: target.contribution, credentialSlotId: target.slot });
    if (target.kind === 'plugin') {
        const binding = resolveAccountSettingsPluginSecretBinding(input.settings ?? {},
            { pluginId: target.pluginId, localId: target.localId });
        return binding ? [binding.savedSecretId] : [];
    }
    if (target.kind === 'provider' && input.providerConnections) {
        const contributionKey = canonicalizeProviderContributionKeyV1(target.contributionKey);
        const connectionIds = new Set<string>(input.providerConnections.connections.filter(connection => connection.source.kind === 'contribution'
            && canonicalizeProviderContributionKeyV1(connection.source.contributionKey) === contributionKey).map(connection => connection.id));
        return [...new Set(listProviderConnectionsCatalogSavedSecretRefsV1(input.providerConnections)
            .filter(reference => reference.slot === target.slot && connectionIds.has(reference.referrer.id))
            .map(reference => reference.secretId))];
    }
    if (target.kind === 'service' && input.connectedConfigurations) {
        return [...new Set(listConnectedConfigurationCatalogSavedSecretRefsV1(input.connectedConfigurations)
            .filter(reference => reference.service.pluginId === target.service.pluginId && reference.service.localId === target.service.localId
                && reference.modeId === target.modeId && reference.fieldId === target.fieldId)
            .map(reference => reference.secretId))];
    }
    return [];
}

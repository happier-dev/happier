import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { MachineSetupObservationV1 } from '@happier-dev/protocol/machines/setup/machineSetupObservationV1';
import type { MachineRecipeReferenceV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { readMcpPluginItemMetadataFromProjectionV1 } from '@happier-dev/protocol/mcp/servers/pluginItemsV1';
import { mcpPluginItemIdV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import type { PluginProjectionEditableSettingField } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { findMcpSignInGrant } from '@/components/settings/mcpServers/signIn/mcpSignInGrantView';
import { connectedAccountPurposeServiceTargets } from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import { isConnectedAccountSignedOut } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';

type SettingsSetupField = Pick<PluginProjectionEditableSettingField, 'key' | 'secretCustody' | 'title' | 'defaultValue' | 'required'>;

/** Presence-only facts from the Account or Machine settings record already open for this plugin. */
export type PluginSettingSetupObservation = Readonly<{
    field: SettingsSetupField;
    status: 'missing' | 'configured' | 'unknown';
}>;

export type InstalledPluginSetupRow =
    | Readonly<{ kind: 'connectedAccount'; service: PluginContributionIdentityV1 }>
    | Readonly<{ kind: 'mcpSignIn'; serverId: string; title: string }>
    | Readonly<{ kind: 'setting' | 'secret'; fieldId: string; title: SettingsSetupField['title'] }>
    | Readonly<{ kind: 'machineRecipe'; ref: MachineRecipeReferenceV1 }>;

/** Reads only the admitted projection and published presence. Unknown facts contribute no row. */
export function projectInstalledPluginSetup(input: Readonly<{
    pluginId: string;
    projection: PluginProjectionV2 | null;
    connections: Readonly<{
        profiles: readonly QualifiedConnectedAccountProfileV4[];
        groups: readonly QualifiedConnectedAccountGroupV4[];
    }> | null;
    settings: readonly PluginSettingSetupObservation[];
    machineSetup: MachineSetupObservationV1 | null;
}>): readonly InstalledPluginSetupRow[] {
    const rows: InstalledPluginSetupRow[] = [];
    const { pluginId, projection, connections } = input;
    if (projection && connections) {
        const requiredServices = new Map<string, PluginContributionIdentityV1>();
        for (const agent of Object.values(projection.agentsById)) {
            if (agent.identity?.pluginId !== pluginId) continue;
            for (const purpose of agent.connectedAccounts ?? []) {
                if (purpose.required === true) requiredServices.set(buildQualifiedPluginContributionKey(purpose.service), purpose.service);
            }
        }
        for (const service of requiredServices.values()) {
            const targets = connectedAccountPurposeServiceTargets(connections.profiles, connections.groups, service);
            if (targets.groups.length === 0 && targets.accounts.every(account => isConnectedAccountSignedOut(account.status))) {
                rows.push({ kind: 'connectedAccount', service });
            }
        }

        for (const entry of Object.values(projection.familiesById.mcp?.entriesById ?? {})) {
            if (entry.pluginId !== pluginId || entry.contributionKind !== 'server' || typeof entry.localId !== 'string') continue;
            const id = mcpPluginItemIdV1({ pluginId, localId: entry.localId });
            const [item] = readMcpPluginItemMetadataFromProjectionV1(projection, id);
            if (!item?.remote) continue;
            const grant = findMcpSignInGrant(connections.profiles, id);
            if (!grant || isConnectedAccountSignedOut(grant.status)) {
                rows.push({ kind: 'mcpSignIn', serverId: id, title: item.title ?? item.name });
            }
        }
    }

    for (const { field, status } of input.settings) {
        if (field.required === true && field.defaultValue === undefined && status === 'missing') {
            rows.push({ kind: field.secretCustody === null ? 'setting' : 'secret', fieldId: field.key, title: field.title });
        }
    }

    for (const recipe of input.machineSetup?.recipes ?? []) {
        if (recipe.ref.pluginId === pluginId && recipe.status === 'drifted') {
            rows.push({ kind: 'machineRecipe', ref: recipe.ref });
        }
    }

    return rows;
}

import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { MachineSetupObservationV1 } from '@happier-dev/protocol/machines/setup/machineSetupObservationV1';
import type { MachineRecipeV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineSetupRecipeItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { readMcpPluginItemMetadataFromProjectionV1 } from '@happier-dev/protocol/mcp/servers/pluginItemsV1';
import { mcpPluginItemIdV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { findMcpSignInGrant } from '@/components/settings/mcpServers/signIn/mcpSignInGrantView';
import { connectedAccountPurposeServiceTargets } from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import { isConnectedAccountSignedOut } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';

import { requiresPluginSettingSetup, type PluginSettingSetupObservation, type SettingsSetupField } from './pluginSettingSetupObservation';

type SetupStepDetails =
    /** `title` is the plugin's projected display text (resolve with the plugin text resolver); null when undeclared. */
    | Readonly<{ kind: 'connectedAccount'; service: PluginContributionIdentityV1; title: unknown }>
    | Readonly<{ kind: 'mcpSignIn'; serverId: string; title: string }>
    | Readonly<{ kind: 'setting' | 'secret'; fieldId: string; title: SettingsSetupField['title'] }>
    | Readonly<{ kind: 'machineRecipe'; item: MachineSetupRecipeItemV1; title: MachineRecipeV1['title'] }>;

export type InstalledPluginSetupRow = SetupStepDetails & Readonly<{ id: string }>;

export type InstalledPluginSetupStep = InstalledPluginSetupRow & Readonly<{
    status: 'pending' | 'done' | 'skipped';
}>;

export type InstalledPluginSetup = Readonly<{
    rows: readonly InstalledPluginSetupRow[];
    steps: readonly InstalledPluginSetupStep[];
    progress: Readonly<{ done: number; total: number }>;
    settingsPending: boolean;
}>;

/** Project settled observations only. Completed and skipped steps count toward progress. */
export function projectInstalledPluginSetup(input: Readonly<{
    pluginId: string;
    projection: PluginProjectionV2 | null;
    connections: Readonly<{
        profiles: readonly QualifiedConnectedAccountProfileV4[];
        groups: readonly QualifiedConnectedAccountGroupV4[];
    }> | null;
    settings: readonly PluginSettingSetupObservation[] | null;
    machineId: string | null;
    machineSetup: MachineSetupObservationV1 | null;
    skippedStepIds?: readonly string[];
}>): InstalledPluginSetup {
    const rows: InstalledPluginSetupRow[] = [];
    const steps: InstalledPluginSetupStep[] = [];
    const skipped = new Set(input.skippedStepIds);
    const addStep = (step: SetupStepDetails, identity: readonly (string | null)[], done: boolean) => {
        const id = JSON.stringify(identity);
        const status = done ? 'done' : skipped.has(id) ? 'skipped' : 'pending';
        const observed: InstalledPluginSetupStep = { ...step, id, status };
        steps.push(observed);
        if (status === 'pending') rows.push(observed);
    };
    const { pluginId, projection, connections } = input;
    if (projection && connections) {
        const requiredServices = new Map<string, PluginContributionIdentityV1>();
        for (const agent of Object.values(projection.agentsById)) {
            if (agent.identity?.pluginId !== pluginId) continue;
            for (const purpose of agent.connectedAccounts ?? []) {
                if (purpose.required === true) requiredServices.set(buildQualifiedPluginContributionKey(purpose.service), purpose.service);
            }
        }
        for (const [serviceKey, service] of requiredServices) {
            const targets = connectedAccountPurposeServiceTargets(connections.profiles, connections.groups, service);
            const done = targets.groups.length > 0 || targets.accounts.some(account => !isConnectedAccountSignedOut(account.status));
            const declared = Object.values(projection.familiesById.connectedAccounts?.entriesById ?? {})
                .find(entry => entry.pluginId === service.pluginId && entry.serviceId === service.localId);
            addStep({ kind: 'connectedAccount', service, title: declared?.title ?? null },
                ['connectedAccount', serviceKey], done);
        }

        for (const entry of Object.values(projection.familiesById.mcp?.entriesById ?? {})) {
            if (entry.pluginId !== pluginId || entry.contributionKind !== 'server' || typeof entry.localId !== 'string') continue;
            const id = mcpPluginItemIdV1({ pluginId, localId: entry.localId });
            const [item] = readMcpPluginItemMetadataFromProjectionV1(projection, id);
            if (!item?.remote) continue;
            const grant = findMcpSignInGrant(connections.profiles, id);
            addStep({ kind: 'mcpSignIn', serverId: id, title: item.title ?? item.name },
                ['mcpSignIn', id], grant !== null && !isConnectedAccountSignedOut(grant.status));
        }
    }

    let settingsPending = input.settings === null;
    for (const { field, status } of input.settings ?? []) {
        if (!requiresPluginSettingSetup(field)) continue;
        if (status === 'unknown') {
            settingsPending = true;
            continue;
        }
        const kind = field.secretCustody === null ? 'setting' : 'secret';
        addStep({ kind, fieldId: field.key, title: field.title },
            [kind, field.key, field.secretCustody, field.secretCustody === 'daemon' ? input.machineId : null],
            status === 'configured');
    }

    const satisfiedRecipes = new Map(
        (input.machineSetup?.recipes ?? []).flatMap(({ ref, status }) =>
            ref.pluginId === pluginId && status === 'satisfied' ? [[ref.recipeId, ref.revision] as const] : []),
    );
    for (const declared of Object.values(projection?.familiesById.machineRecipes?.entriesById ?? {})) {
        if (declared.pluginId !== pluginId) continue;
        const { definition } = declared;
        const ref = { pluginId, recipeId: definition.id, revision: definition.revision };
        const item: MachineSetupRecipeItemV1 = {
            kind: definition.software ? 'softwareRecipe' : 'setupRecipe',
            selection: { ref, inputs: {} },
        };
        addStep({ kind: 'machineRecipe', item, title: definition.title },
            ['machineRecipe', input.machineId, ref.recipeId, ref.revision], satisfiedRecipes.get(ref.recipeId) === ref.revision);
    }

    return { rows, steps, progress: { done: steps.length - rows.length, total: steps.length }, settingsPending };
}

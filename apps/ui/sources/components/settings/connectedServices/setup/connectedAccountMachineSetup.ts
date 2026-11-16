import type { PluginConnectedAccountMachineSetupV1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { readDeploymentDomainHostnameV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
import { readInputPath, writeInputPath } from '@happier-dev/protocol/inputs';
import type { MachinePresetItemV1, MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineReachabilityObservationV1 } from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';
import { accessProviderRefsEqualV1, type AccessProviderRefV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { PluginJsonValueV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';

function isDeclaredRecipe(
    item: MachinePresetItemV1,
    declaration: PluginConnectedAccountMachineSetupV1,
): item is Extract<MachinePresetItemV1, { kind: 'setupRecipe' }> {
    return item.kind === 'setupRecipe'
        && item.selection.ref.pluginId === declaration.recipe.pluginId
        && item.selection.ref.recipeId === declaration.recipe.recipeId
        && item.selection.ref.revision === declaration.recipe.revision;
}

function readPrivateNetworkHttpsOrigin(
    provider: AccessProviderRefV1,
    observation: MachineReachabilityObservationV1 | null,
): string | null {
    const matching = observation?.privateNetworks.filter(network => accessProviderRefsEqualV1(network.provider, provider));
    if (matching?.length !== 1 || matching[0]!.state !== 'ready') return null;
    const hostname = readDeploymentDomainHostnameV1(matching[0]!.dnsName);
    return hostname ? `https://${hostname}` : null;
}

/** A new reviewed setup carries only the declared recipe and explicit public input suggestions. */
export function createConnectedAccountMachineSetupDraft(
    declaration: PluginConnectedAccountMachineSetupV1,
    observation: MachineReachabilityObservationV1 | null,
): MachineSetupV1 {
    return prefillConnectedAccountMachineSetupDraft(declaration, {
        items: [{ kind: 'setupRecipe', selection: { ref: declaration.recipe, inputs: {} } }],
    }, observation);
}

/** Late Network facts may fill an absent input; even an explicitly empty user value stays authoritative. */
export function prefillConnectedAccountMachineSetupDraft(
    declaration: PluginConnectedAccountMachineSetupV1,
    setup: MachineSetupV1,
    observation: MachineReachabilityObservationV1 | null,
): MachineSetupV1 {
    let changed = false;
    const items = setup.items?.map(item => {
        if (!isDeclaredRecipe(item, declaration)) return item;
        let inputs = item.selection.inputs;
        if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return item;
        for (const prefill of declaration.inputPrefill ?? []) {
            if (readInputPath(inputs, prefill.path) !== undefined) continue;
            const origin = readPrivateNetworkHttpsOrigin(prefill.source.provider, observation);
            if (origin === null) continue;
            // The shared writer preserves the JSON inputs and inserts only this public string.
            inputs = writeInputPath(inputs, prefill.path, origin) as Record<string, PluginJsonValueV2>;
        }
        if (inputs === item.selection.inputs) return item;
        changed = true;
        return { ...item, selection: { ...item.selection, inputs } };
    });
    return changed ? { ...setup, items } : setup;
}

/** Only the declaration's exact reviewed recipe supplies its explicitly mapped configuration fields. */
export function resolveAfterApplyConfiguration(
    declaration: PluginConnectedAccountMachineSetupV1,
    setup: MachineSetupV1,
): Record<string, PluginJsonValueV2> {
    const item = setup.items?.find(candidate => isDeclaredRecipe(candidate, declaration));
    if (!item || item.kind !== 'setupRecipe') return {};
    return Object.fromEntries(Object.entries(declaration.afterApply.configurationFromInputs).flatMap(([fieldId, path]) => {
        // Recipe inputs are already admitted JSON; traversal only selects one of those values.
        const value = readInputPath(item.selection.inputs, path) as PluginJsonValueV2 | undefined;
        return value === undefined ? [] : [[fieldId, value]];
    }));
}

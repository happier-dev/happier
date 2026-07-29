import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
} from '@happier-dev/protocol';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    createStablePluginDeclarativeModel,
    type StablePluginDeclarativeModel,
} from '@/plugins/runtime/invocation/services/declarativeModel';
import { createStablePluginSettingsModel } from '@/plugins/runtime/invocation/services/settings';
import { resolveLocalSettingsDeclarations } from '@/plugins/settings/localSettingsContributions';

import type { ResolvedContributionRegistry } from '../types';

type DeclarativeActionRuntime = Pick<
    NonNullable<ResolvedExecutablePluginRuntimeRegistry['targetActionInvocations']>,
    'has' | 'evaluateCatalogPolicy'
>;

export function resolveDeclarativeProjectionModels(params: Readonly<{
    registry: ResolvedContributionRegistry;
    generation: number;
    actionRuntime?: DeclarativeActionRuntime;
}>): Readonly<Record<string, StablePluginDeclarativeModel>> {
    const modelsByRendererKey: Record<string, StablePluginDeclarativeModel> = {};
    const actionEntries = (params.registry.actions ?? []).flatMap((action) => {
        const pluginId = action.pluginId?.trim();
        return pluginId
            ? [{
                identity: createPluginContributionIdentity({ pluginId, localId: action.definition.id }),
                exposedOnUi: action.definition.surfaces.ui === true,
            }]
            : [];
    });
    const actions = actionEntries.map((entry) => entry.identity);
    const enabledActions = Object.fromEntries(actionEntries.map(({ identity, exposedOnUi }) => {
        let policyVisible = false;
        try {
            const isCurrent = params.actionRuntime?.has(identity.pluginId, identity.localId) === true;
            policyVisible = exposedOnUi
                && isCurrent
                && params.actionRuntime?.evaluateCatalogPolicy(identity.pluginId, identity.localId).outcome === 'visible';
        } catch {
            // Currentness or policy uncertainty is denial, never executable availability.
        }
        return [buildQualifiedPluginContributionKey(identity), policyVisible];
    }));

    for (const renderer of params.registry.uiRenderersV2 ?? []) {
        if (renderer.definition.kind !== 'declarative') continue;
        const pluginId = renderer.pluginId.trim();
        if (!pluginId) continue;
        try {
            const settingDefinitions = resolveLocalSettingsDeclarations({
                settings: params.registry.settings ?? [],
                pluginId,
            }).map((setting) => setting.definition);
            const settings = settingDefinitions.length > 0
                ? [createStablePluginSettingsModel({ pluginId, contributions: settingDefinitions })]
                : [];
            const model = createStablePluginDeclarativeModel({
                pluginId,
                generation: String(params.generation),
                renderer: renderer.definition,
                settings,
                actions,
                availability: {
                    visible: true,
                    enabledActions,
                },
            });
            modelsByRendererKey[`${pluginId}\0${renderer.definition.id}`] = model;
        } catch {
            // A declarative renderer is executable UI. Invalid or unresolved model inputs
            // must remain unavailable rather than falling back to client-side inference.
        }
    }
    return Object.freeze(modelsByRendererKey);
}

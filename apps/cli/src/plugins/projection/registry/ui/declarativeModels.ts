import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
} from '@happier-dev/protocol';
import { createPluginSessionInfoSectionRendererIdV1 } from '@happier-dev/protocol/plugins/contributions/ui';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    createStablePluginDeclarativeModel,
    type StablePluginDeclarativeModel,
} from '@/plugins/runtime/invocation/services/declarativeModel';
import { createStablePluginSettingsModels } from '@/plugins/runtime/invocation/services/settings';
import { resolveLocalSettingsDeclarations } from '@/plugins/settings/localSettingsContributions';

import type { ResolvedContributionRegistry } from '../types';

type DeclarativeActionRuntime = Pick<
    NonNullable<ResolvedExecutablePluginRuntimeRegistry['targetActionInvocations']>,
    'has' | 'evaluateCatalogPolicy'
>;

export function resolveDeclarativeProjectionModels(params: Readonly<{
    registry: ResolvedContributionRegistry;
    readPluginOccurrenceId(pluginId: string): string | null;
    actionRuntime?: DeclarativeActionRuntime;
    /**
     * Reports a declarative renderer whose model could not be built. The
     * renderer stays unavailable either way; without this the author has no way
     * to learn why their surface silently disappeared.
     */
    onRendererModelUnavailable?(input: Readonly<{
        pluginId: string;
        rendererId: string;
        error: unknown;
    }>): void;
}>): Readonly<Record<string, StablePluginDeclarativeModel>> {
    const modelsByRendererKey: Record<string, StablePluginDeclarativeModel> = {};
    const actionEntries = (params.registry.actions ?? []).flatMap((action) => {
        const pluginId = action.pluginId?.trim();
        return pluginId
            ? [{
                identity: createPluginContributionIdentity({ pluginId, localId: action.definition.id }),
                exposedOnUi: action.definition.surfaces.ui === true,
                title: action.definition.title,
                ...(action.definition.icon ? { icon: action.definition.icon } : {}),
            }]
            : [];
    });
    const actions = actionEntries.map((entry) => entry.identity);
    const actionPresentations = Object.freeze(actionEntries.map(({ identity, title, icon }) => Object.freeze({
        identity,
        title,
        ...(icon ? { icon } : {}),
    })));
    // Surface contribution identity is admitted by the registry and remains
    // the sole navigation inventory. The declarative model never infers a
    // destination from a renderer, route, or display label.
    const destinations = Object.freeze([
        ...(params.registry.uiViewsV2 ?? []),
        ...(params.registry.uiSettingsPagesV2 ?? []),
    ].flatMap((destination) => (
        destination.pluginId.trim()
            ? [destination.identity]
            : []
    )));
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
        const occurrenceId = params.readPluginOccurrenceId(pluginId);
        if (!occurrenceId) continue;
        try {
            const settingDefinitions = resolveLocalSettingsDeclarations({
                settings: params.registry.settings ?? [],
                pluginId,
            }).map((setting) => setting.definition);
            const settings = settingDefinitions.length > 0
                ? [...createStablePluginSettingsModels({
                    pluginId,
                    contributions: settingDefinitions,
                }).values()]
                : [];
            // The Data registry is already normalized before it reaches this
            // projection. Declarative UI consumes only its projected query
            // descriptors; it never reads a manifest, index, or collection
            // schema to reconstruct query authority.
            const uiQueries = Object.freeze((params.registry.accountCollections ?? [])
                .filter((collection) => collection.pluginId === pluginId)
                .flatMap((collection) => collection.definition.uiQueries));
            const model = createStablePluginDeclarativeModel({
                pluginId,
                occurrenceId,
                renderer: renderer.definition,
                settings,
                actions,
                dragSources: (params.registry.dragSources ?? []).filter((source) => source.pluginId === pluginId)
                    .map((source) => ({ identity: source.identity, referenceSchema: source.definition.referenceSchema })),
                dropTargets: (params.registry.dropTargets ?? []).filter((target) => target.pluginId === pluginId)
                    .map((target) => target.identity),
                actionPresentations,
                destinations,
                uiQueries,
                availability: {
                    visible: true,
                    enabledActions,
                },
            });
            modelsByRendererKey[`${pluginId}\0${renderer.definition.id}`] = model;
        } catch (error) {
            // A declarative renderer is executable UI. Invalid or unresolved model inputs
            // must remain unavailable rather than falling back to client-side inference.
            // The refusal is deliberate; destroying its cause was not.
            params.onRendererModelUnavailable?.({
                pluginId,
                rendererId: renderer.definition.id,
                error,
            });
        }
    }
    for (const section of params.registry.sessionInfoSections ?? []) {
        const pluginId = section.pluginId.trim();
        if (!pluginId) continue;
        const occurrenceId = params.readPluginOccurrenceId(pluginId);
        if (!occurrenceId) continue;
        const rendererId = createPluginSessionInfoSectionRendererIdV1(section.definition.id);
        try {
            const permittedActions = actionEntries
                .filter((entry) => entry.identity.pluginId === pluginId
                    && section.definition.actions.includes(entry.identity.localId));
            const permittedEnabledActions = Object.freeze(Object.fromEntries(
                permittedActions.map(({ identity }) => {
                    const qualifiedId = buildQualifiedPluginContributionKey(identity);
                    return [qualifiedId, enabledActions[qualifiedId] === true];
                }),
            ));
            const model = createStablePluginDeclarativeModel({
                pluginId,
                occurrenceId,
                renderer: {
                    id: rendererId,
                    kind: 'declarative',
                    root: { kind: 'state', state: 'loading', title: 'Loading' },
                    documentSource: { kind: 'resource', resourceId: section.definition.resourceId },
                },
                settings: [],
                dragSources: (params.registry.dragSources ?? []).filter((source) => source.pluginId === pluginId)
                    .map((source) => ({ identity: source.identity, referenceSchema: source.definition.referenceSchema })),
                dropTargets: (params.registry.dropTargets ?? []).filter((target) => target.pluginId === pluginId)
                    .map((target) => target.identity),
                actions: permittedActions.map((entry) => entry.identity),
                actionPresentations: permittedActions.map(({ identity, title, icon }) => Object.freeze({
                    identity,
                    title,
                    ...(icon ? { icon } : {}),
                })),
                destinations: [],
                uiQueries: [],
                availability: {
                    visible: true,
                    enabledActions: permittedEnabledActions,
                },
            });
            modelsByRendererKey[`${pluginId}\0${rendererId}`] = model;
        } catch (error) {
            params.onRendererModelUnavailable?.({
                pluginId,
                rendererId,
                error,
            });
        }
    }
    return Object.freeze(modelsByRendererKey);
}

import type { ComposerScopeKindV1} from '@happier-dev/protocol/plugins/ui/composer';
import type { PluginProjectedComposerControlEntryV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import type { AgentInputControlPlacement, AgentInputPlacementContext, AgentInputPluginControlId } from '@/components/sessions/agentInput/controls/agentInputControlTypes';
import type { IconName } from '@/components/ui/icons/Icon';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { createPluginLocalizedTextResolver, type PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { getPreferredLanguage } from '@/text';

import type { PluginContributedActionDescriptor } from './pluginContributedActionController';
import { comparePluginContributedActionDescriptors, resolvePluginContributedActionIconName } from './pluginContributedActionPresentation';

export type PluginComposerPlacementDefinition = Readonly<{
    controlId: AgentInputPluginControlId;
    placement: AgentInputControlPlacement & Readonly<{ icon: IconName }>;
    contexts?: readonly AgentInputPlacementContext[];
}>;
type ComposerActionPlacement = Pick<PluginContributedActionDescriptor, 'qualifiedActionId' | 'title' | 'icon' | 'placement'>;

function composerControlContexts(scopes: readonly ComposerScopeKindV1[]): readonly AgentInputPlacementContext[] {
    return [...new Set(scopes.flatMap((scope): readonly AgentInputPlacementContext[] => {
        switch (scope) {
            case 'session':
            case 'pendingMessage':
            case 'participantMessage':
                return ['session'];
            case 'newSession':
                return ['newSession'];
            case 'discussion':
                return ['discussion'];
            case 'workflowAuthoring':
                return ['workflow'];
            case 'automationAuthoring':
                return [];
        }
    }))];
}

/** Shared metadata for live chips and the Settings catalog; no interaction or Resource state. */
export function createPluginComposerActionPlacement(
    action: ComposerActionPlacement,
): PluginComposerPlacementDefinition {
    const controlId = `plugin:action:${action.qualifiedActionId}` as const;
    return {
        controlId,
        placement: {
            id: controlId,
            title: action.title,
            icon: resolvePluginContributedActionIconName(action.icon),
            defaultPlacement: action.placement === 'composer.primary' ? 'pinned' : 'overflow',
        },
    };
}

export function createPluginComposerControlPlacement(
    control: PluginProjectedComposerControlEntryV1,
    localize: PluginLocalizedTextResolver,
): PluginComposerPlacementDefinition {
    const controlId = `plugin:control:${control.id}` as const;
    return {
        controlId,
        placement: {
            id: controlId,
            title: localize(control.pluginId, control.definition.label),
            icon: resolvePluginUiIconName(control.definition.icon),
            defaultPlacement: control.definition.defaultPlacement ?? 'overflow',
        },
    };
}

/** Primary descriptors win before any node or placement definition is created. */
export function dedupePluginComposerActions<T extends Readonly<{ qualifiedActionId: string }>>(
    primary: readonly T[],
    more: readonly T[],
): readonly T[] {
    const actions = new Map<string, T>();
    for (const action of [...primary, ...more]) {
        if (!actions.has(action.qualifiedActionId)) actions.set(action.qualifiedActionId, action);
    }
    return [...actions.values()];
}

type OrderedComposerContribution = Readonly<{
    id: string;
    definition: Readonly<{ order?: number }>;
}>;

/** Admitted map insertion order never determines the physical control or region order. */
export function compareOrderedComposerContributions(
    left: OrderedComposerContribution,
    right: OrderedComposerContribution,
): number {
    return (left.definition.order ?? 0) - (right.definition.order ?? 0)
        || left.id.localeCompare(right.id);
}

/**
 * Descriptive Settings inventory from the shell's already-admitted declarations.
 * Availability, current scope, Resources and execution stay with live consumers.
 */
export function buildPluginComposerPlacementDefinitions(
    projection: PluginUiProjectionModel | null | undefined,
    options: Readonly<{ locale?: string | null; localize?: PluginLocalizedTextResolver }> = {},
): readonly PluginComposerPlacementDefinition[] {
    if (!projection) return [];
    const locale = options.locale ?? getPreferredLanguage();
    const localize = options.localize ?? createPluginLocalizedTextResolver({ projection, locale });
    const actions = Object.values(projection.actionsById)
        .filter(action => action.surfaces.includes('ui'))
        .map(action => ({
            qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId: action.pluginId, localId: action.id }),
            title: localize(action.pluginId, action.title),
            icon: action.icon ?? null,
            priority: action.priority ?? 0,
            placementBindings: action.placementBindings ?? [],
            // Only Session hosts currently request the controller's Session Action rows.
            contexts: action.scopes.includes('session') ? ['session'] as const : [],
        }))
        .sort(comparePluginContributedActionDescriptors);
    const primary = actions.filter(action => action.placementBindings.includes('composer.primary'))
        .map(action => ({ ...action, placement: 'composer.primary' as const }));
    const more = actions.filter(action => action.placementBindings.includes('composer.more'))
        .map(action => ({ ...action, placement: 'composer.more' as const }));
    return [
        ...dedupePluginComposerActions<ComposerActionPlacement & Readonly<{ contexts: readonly AgentInputPlacementContext[] }>>(primary, more)
            .map(action => ({ ...createPluginComposerActionPlacement(action), contexts: action.contexts })),
        ...Object.values(projection.composerControlsById)
            .sort(compareOrderedComposerContributions)
            .map(control => ({
                ...createPluginComposerControlPlacement(control, localize),
                ...(control.definition.scopes ? { contexts: composerControlContexts(control.definition.scopes) } : {}),
            })),
    ];
}

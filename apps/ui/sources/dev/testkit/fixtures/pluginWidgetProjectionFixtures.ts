import type { PluginProjectionV2, PluginJsonSchemaV2, PluginContributionIdentityV1, PluginProjectedResourceV2 } from '@happier-dev/protocol';
import type { InputHints } from '@happier-dev/protocol/inputs';
import { normalizePluginUiInlineSurfaceBindingV1, type PluginUiInlineSurfaceBindingV1 } from '@happier-dev/protocol/plugins/ui';

import {
    normalizePluginUiProjection,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import type { WidgetHomeDefault, WidgetTargetKind } from '@/sync/domains/plugins/ui/widgetContract';
import { WIDGET_ROLE } from '@/sync/domains/plugins/ui/widgetContract';

/**
 * Projected plugin widget placements for host tests (Board picker, Home, the installed-widget arm),
 * through the real Protocol binding normalizer and UI projection normalizer. App widgets carry the
 * `home` default exactly as the daemon projects it onto the row.
 */

export type WidgetFixtureEntry = Readonly<{
    pluginId: string;
    localId: string;
    title?: string;
    target?: WidgetTargetKind;
    homeDefault?: WidgetHomeDefault;
    inputs?: InputHints;
    inputSchema?: PluginJsonSchemaV2;
    sessionInputPath?: string;
    role?: typeof WIDGET_ROLE | 'sessionSubagentDetails';
    entryId?: string;
    availability?: 'available' | 'unavailable';
    featureGate?: string;
    requiredPermissionIds?: readonly string[];
    capabilityIds?: readonly string[];
    platforms?: readonly ('web' | 'desktop' | 'ios' | 'android')[];
    occurrenceId?: string;
    resources?: readonly PluginContributionIdentityV1[];
}>;

function entryId(input: WidgetFixtureEntry): string {
    return input.entryId ?? `surfacePlacement:${input.pluginId}:${input.localId}`;
}

export function widgetProjectionEntry(input: WidgetFixtureEntry) {
    const sessionWidget = (input.target ?? 'session') === 'session' && (input.role ?? WIDGET_ROLE) === WIDGET_ROLE;
    const inputs = input.inputs ?? (sessionWidget ? { fields: [{ path: 'session', title: 'Session', widget: 'json' as const, required: true }] } : undefined);
    const inputSchema = input.inputSchema ?? (sessionWidget ? {
        type: 'object', properties: { session: { type: 'object', properties: { serverId: { type: 'string', minLength: 1 }, sessionId: { type: 'string', minLength: 1 } }, required: ['serverId', 'sessionId'], additionalProperties: false } }, required: ['session'], additionalProperties: false,
    } : undefined);
    const binding: PluginUiInlineSurfaceBindingV1 | null = normalizePluginUiInlineSurfaceBindingV1({
        pluginId: input.pluginId,
        surfaceId: input.localId,
        rendererId: 'widget-native',
        role: input.role ?? WIDGET_ROLE,
        target: { kind: input.target ?? 'session' },
    });
    if (!binding) throw new Error('fixture must use an admitted inline binding');
    return {
        id: entryId(input),
        pluginId: input.pluginId,
        contributionKind: 'surfacePlacement',
        descriptorId: input.localId,
        // The daemon producer stamps every projected UI entry with its exact plugin-slot
        // occurrence; a fixture without one is not a projection the product can produce.
        occurrenceId: input.occurrenceId ?? `${input.pluginId}#1`,
        binding,
        target: binding.target,
        renderer: { kind: 'declarative', contributionId: 'widget-native' },
        display: { title: input.title ?? input.localId },
        ...(input.homeDefault ? { home: { default: input.homeDefault } } : {}),
        ...(inputs ? { inputs } : {}),
        ...(inputSchema ? { inputSchema } : {}),
        ...(input.resources ? { resources: input.resources } : {}),
        ...((input.sessionInputPath ?? (sessionWidget ? 'session' : undefined)) ? { sessionInputPath: input.sessionInputPath ?? 'session' } : {}),
        availability: {
            state: input.availability === 'unavailable' ? 'disabled' : 'available',
            reason: input.availability === 'unavailable' ? 'plugin_disabled' : 'available',
            diagnostics: [],
            ...(input.featureGate || input.platforms || input.capabilityIds ? { when: { all: [
                ...(input.featureGate ? [{ fact: 'host.feature', operator: 'enabled', value: input.featureGate }] : []),
                ...(input.platforms ? [{ any: input.platforms.map(platform => ({ fact: 'host.platform', operator: 'equals', value: platform })) }] : []),
                ...(input.capabilityIds?.map(value => ({ fact: 'session.capability', operator: 'contains', value })) ?? []),
            ] } } : {}),
        },
    };
}

export function widgetInstalledPackage(id: string, displayName: string) {
    return { id, displayName, enabled: true, source: { kind: 'local', path: `/plugins/${id}` } };
}

/** A projection holding exactly these widget entries and installed packages. */
export function widgetProjectionOf(
    entries: readonly WidgetFixtureEntry[],
    installedPackagesById: Readonly<Record<string, unknown>> = {},
    resourcesById: Readonly<Record<string, PluginProjectedResourceV2>> = {},
): PluginUiProjectionModel {
    const raw = entries.map(widgetProjectionEntry);
    return normalizePluginUiProjection({
        v: 2,
        generation: 1,
        installedPackagesById,
        actionsById: {},
        resourcesById,
        familiesById: {
            pluginUi: { entriesById: Object.fromEntries(raw.map((entry) => [entry.id, entry])) },
        },
    } as unknown as PluginProjectionV2);
}

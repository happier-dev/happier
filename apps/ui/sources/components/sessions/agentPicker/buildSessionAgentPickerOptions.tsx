import * as React from 'react';

import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type {
    AgentInputChipPickerOption,
    AgentInputChipPickerOptionRailAction,
} from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { sortItemsByFavoriteTargetKey } from '@/sync/domains/session/authoring/favoriteBackendTargets';

const AGENT_PICKER_ICON_SIZE = 14;

/**
 * How one Agent row reads: an optional explanation plus whether it can be applied.
 *
 * `muted` de-emphasizes a row that stays inspectable; `disabled` additionally blocks
 * applying it. Callers own the policy, this owner only renders its consequence.
 */
export type SessionAgentPickerOptionPresentation = Readonly<{
    subtitle?: string;
    /**
     * Overrides the row's accessible name when its state is carried by a marker
     * rather than by a second line of copy.
     */
    accessibilityLabel?: string;
    disabled: boolean;
    muted: boolean;
    /**
     * The rail group the row belongs to ("Not on devbox yet"), when the surface groups rows by where
     * the agent can run. Groups keep their `rank` order; rows without one lead.
     */
    section?: Readonly<{ id: string; label: string; rank: number }>;
    /** A state mark in the row's indicator slot (not installed, needs sign-in), drawn when the row is not the selection. */
    statusMarker?: React.ReactNode;
    /** The status mark's own operation (install from the download glyph). */
    statusAction?: AgentInputChipPickerOption['statusAction'];
}>;

export type SessionAgentPickerOptionBehavior = Pick<
    AgentInputChipPickerOption,
    | 'closeOnSelectImmediate'
    | 'onSelectImmediate'
    | 'renderDetailContent'
    | 'deferRenderDetailContent'
    | 'deferredDetailContentCacheKey'
    | 'preserveFocusOnExternalSelectionChange'
    | 'detailTitle'
    | 'detailDescription'
    | 'detailActionLabel'
    | 'onDetailAction'
>;

export type SessionAgentPickerOptionContext = Readonly<{
    entry: ResolvedBackendCatalogEntry;
    presentation: SessionAgentPickerOptionPresentation;
    favorite: boolean;
}>;

type BuildSessionAgentPickerOptionsParams = Readonly<{
    entries: readonly ResolvedBackendCatalogEntry[];
    favoriteBackendTargetKeys?: ReadonlyArray<string>;
    /** Rows that precede the Agent catalog, such as the favorite-models view. */
    leadingOptions?: ReadonlyArray<AgentInputChipPickerOption>;
    identityScope: Readonly<{
        machineId: string | null;
        serverId: string | null;
        current: boolean;
    }>;
    resolvePresentation: (entry: ResolvedBackendCatalogEntry) => SessionAgentPickerOptionPresentation;
    resolveRailAction?: (context: SessionAgentPickerOptionContext) => AgentInputChipPickerOptionRailAction | undefined;
    resolveBehavior: (context: SessionAgentPickerOptionContext) => SessionAgentPickerOptionBehavior;
}>;

export function resolveSessionAgentPickerOptionIcon(
    entry: ResolvedBackendCatalogEntry,
    identityScope: BuildSessionAgentPickerOptionsParams['identityScope'],
): React.ReactNode {
    return (
        <AgentCatalogIdentityIcon
            entry={entry.agentCatalogEntry}
            machineId={identityScope.machineId}
            serverId={identityScope.serverId}
            current={identityScope.current}
            size={AGENT_PICKER_ICON_SIZE}
        />
    );
}

/**
 * Projects Agent catalog entries into the shared chip-picker option shape.
 *
 * This is the single option/detail composition behind every Agent picker surface:
 * New Session, the in-session composer picker, and fork/source-context authoring.
 * Favorites lead, then applicable rows, then de-emphasized rows, then blocked rows,
 * so the eye lands on what can actually be chosen before what cannot.
 */
export function buildSessionAgentPickerOptions(
    params: BuildSessionAgentPickerOptionsParams,
): ReadonlyArray<AgentInputChipPickerOption> {
    const favoriteBackendTargetKeys = params.favoriteBackendTargetKeys ?? [];
    const favoriteBackendTargetKeySet = new Set(favoriteBackendTargetKeys);
    const sortedEntries = sortItemsByFavoriteTargetKey(
        params.entries,
        favoriteBackendTargetKeys,
        (entry) => entry.backendTargetKey,
    );

    const sectionRankById = new Map<string, number>();
    const available: AgentInputChipPickerOption[] = [];
    const muted: AgentInputChipPickerOption[] = [];
    const disabled: AgentInputChipPickerOption[] = [];

    for (const entry of sortedEntries) {
        const presentation = params.resolvePresentation(entry);
        const context: SessionAgentPickerOptionContext = {
            entry,
            presentation,
            favorite: favoriteBackendTargetKeySet.has(entry.backendTargetKey),
        };
        const option: AgentInputChipPickerOption = {
            id: entry.backendTargetKey,
            label: entry.title,
            icon: resolveSessionAgentPickerOptionIcon(entry, params.identityScope),
            subtitle: presentation.subtitle,
            accessibilityLabel: presentation.accessibilityLabel,
            disabled: presentation.disabled,
            muted: presentation.muted,
            ...(presentation.section ? { sectionId: presentation.section.id, sectionLabel: presentation.section.label } : {}),
            ...(presentation.statusMarker ? { statusMarker: presentation.statusMarker } : {}),
            ...(presentation.statusAction ? { statusAction: presentation.statusAction } : {}),
            railAction: params.resolveRailAction?.(context),
            ...params.resolveBehavior(context),
        };
        if (presentation.section) sectionRankById.set(presentation.section.id, presentation.section.rank);

        if (option.disabled) {
            disabled.push(option);
            continue;
        }
        if (option.muted) {
            muted.push(option);
            continue;
        }
        available.push(option);
    }

    // Grouped rows keep their group's order (the rail draws one heading per group, in first-seen order).
    const rankOf = (option: AgentInputChipPickerOption) => (option.sectionId ? sectionRankById.get(option.sectionId) ?? 0 : -1);
    const byGroup = (list: AgentInputChipPickerOption[]) => (sectionRankById.size === 0
        ? list
        : list.map((option, index) => ({ option, index }))
            .sort((a, b) => rankOf(a.option) - rankOf(b.option) || a.index - b.index)
            .map(({ option }) => option));
    return [
        ...(params.leadingOptions ?? []),
        ...byGroup([...available, ...muted, ...disabled]),
    ];
}

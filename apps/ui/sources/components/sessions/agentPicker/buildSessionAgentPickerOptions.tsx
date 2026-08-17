import * as React from 'react';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type {
    AgentInputChipPickerOption,
    AgentInputChipPickerOptionRailAction,
} from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { Icon } from '@/components/ui/icons/Icon';
import { sortItemsByFavoriteTargetKey } from '@/sync/domains/session/authoring/favoriteBackendTargets';

const AGENT_PICKER_ICON_SIZE = 12;
const AGENT_PICKER_FALLBACK_ICON_SIZE = 14;

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
}>;

export type SessionAgentPickerOptionBehavior = Pick<
    AgentInputChipPickerOption,
    | 'closeOnSelectImmediate'
    | 'onSelectImmediate'
    | 'renderDetailContent'
    | 'deferRenderDetailContent'
    | 'deferredDetailContentCacheKey'
    | 'preserveFocusOnExternalSelectionChange'
    | 'onApply'
    | 'applyLabel'
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
    resolvePresentation: (entry: ResolvedBackendCatalogEntry) => SessionAgentPickerOptionPresentation;
    resolveRailAction?: (context: SessionAgentPickerOptionContext) => AgentInputChipPickerOptionRailAction | undefined;
    resolveBehavior: (context: SessionAgentPickerOptionContext) => SessionAgentPickerOptionBehavior;
}>;

export function resolveSessionAgentPickerOptionIcon(entry: ResolvedBackendCatalogEntry): React.ReactNode {
    const displayAgentId = entry.iconAgentId ?? entry.catalogAgentId ?? entry.builtInAgentId;
    if (!displayAgentId) {
        return <Icon name="stack-simple" size={AGENT_PICKER_FALLBACK_ICON_SIZE} />;
    }
    return (
        <AgentIcon
            agentId={displayAgentId}
            size={AGENT_PICKER_ICON_SIZE}
            style={{ transform: [{ scale: getAgentPickerIconScale(displayAgentId) }] }}
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
            icon: resolveSessionAgentPickerOptionIcon(entry),
            subtitle: presentation.subtitle,
            accessibilityLabel: presentation.accessibilityLabel,
            disabled: presentation.disabled,
            muted: presentation.muted,
            railAction: params.resolveRailAction?.(context),
            ...params.resolveBehavior(context),
        };

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

    return [
        ...(params.leadingOptions ?? []),
        ...available,
        ...muted,
        ...disabled,
    ];
}

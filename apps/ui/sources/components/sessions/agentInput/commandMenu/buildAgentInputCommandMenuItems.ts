import * as React from 'react';

import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import { resolveComposerSuggestionKind } from '@/components/autocomplete/composerSuggestionKinds';
import type { CommandMenuItem } from '@/components/ui/commandMenu/commandMenuTypes';
import { t } from '@/text';

/**
 * Maps the `AutocompleteSuggestion[]` pipeline into `CommandMenuItem[]` that
 * `<CommandMenu>` renders.
 *
 * `group` carries the picker's typed section headers (R-1). `CommandMenu` folds
 * consecutive items sharing a group into one `SelectionList` static section — the
 * mechanism the markdown slash menu has used in production since `markdown.slash.groups.*`.
 * The suggestion list already arrives ordered by section, so consecutive-equality
 * is exactly the grouping we want and no picker, row or section-header primitive
 * is introduced here (D-1, D-17).
 *
 * Only the file kind keeps `renderRow`: it needs `InlineRepoPathLabel`'s path-aware
 * truncation. Plugin and skill rows are the primitive's default icon + label +
 * subtitle, supplied by the registry.
 *
 * The original suggestion is preserved as `meta` so the host can retrieve it in
 * `onSelect` without maintaining a parallel lookup.
 */
export function buildAgentInputCommandMenuItems(
    suggestions: readonly AutocompleteSuggestion[],
): readonly CommandMenuItem[] {
    return suggestions.map((suggestion): CommandMenuItem => {
        const kind = resolveComposerSuggestionKind(suggestion.kind);
        const component = suggestion.component;

        return {
            id: suggestion.key,
            label: suggestion.label ?? suggestion.text,
            description: suggestion.description,
            group: t(kind.sectionTitleKey),
            icon: component ? undefined : kind.icon?.(),
            rowHeight: suggestion.rowHeight,
            renderRow: component ? () => React.createElement(component) : undefined,
            meta: suggestion,
        };
    });
}

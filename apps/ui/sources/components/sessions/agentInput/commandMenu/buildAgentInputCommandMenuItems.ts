import * as React from 'react';

import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import type { CommandMenuItem } from '@/components/ui/commandMenu/commandMenuTypes';

export function buildAgentInputCommandMenuItems(
    suggestions: readonly AutocompleteSuggestion[],
): readonly CommandMenuItem[] {
    return suggestions.map((suggestion): CommandMenuItem => {
        const hasComponent = typeof suggestion.component === 'function';

        return {
            id: suggestion.key,
            label: suggestion.label ?? suggestion.text,
            description: suggestion.description,
            rowHeight: suggestion.rowHeight,
            renderRow: hasComponent ? () => React.createElement(suggestion.component!) : undefined,
            meta: suggestion,
        };
    });
}


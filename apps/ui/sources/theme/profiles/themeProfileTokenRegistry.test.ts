import { describe, expect, it } from 'vitest';

import { EDITABLE_THEME_COLOR_TOKEN_DEFINITIONS } from '../tokens/themeColorTokenDefinitions';
import { THEME_PROFILE_TOKEN_DEFINITIONS } from './themeProfileTokenRegistry';

describe('theme profile token registry', () => {
    it('stays in parity with the canonical public editable color token definitions', () => {
        const publicDefinitions = EDITABLE_THEME_COLOR_TOKEN_DEFINITIONS.map((definition) => ({
            id: definition.id,
            path: [...definition.path],
            group: definition.group,
            label: definition.label,
            description: definition.description,
            contrastPairs: 'contrastPairs' in definition ? definition.contrastPairs : undefined,
        }));
        const profileDefinitions = THEME_PROFILE_TOKEN_DEFINITIONS.map((definition) => ({
            id: definition.id,
            path: [...definition.path],
            group: definition.group,
            label: definition.label,
            description: definition.description,
            contrastPairs: definition.contrastPairs,
        }));

        expect(profileDefinitions).toEqual(publicDefinitions);
    });
});

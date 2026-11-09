import { describe, expect, it } from 'vitest';

import { getUiFeatureDefinition } from './uiFeatureRegistry';

describe('uiFeatureRegistry session folders', () => {
    it('has no independent folder opt-in for Account section organization', () => {
        const sessionFolders = getUiFeatureDefinition('sessions.folders');

        expect(sessionFolders.settingsToggle).toBeUndefined();
    });
});

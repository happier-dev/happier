import { describe, expect, it } from 'vitest';

import { getUiFeatureDefinition } from './uiFeatureRegistry';

describe('uiFeatureRegistry session folders', () => {
    it('registers session folders as a standard enabled-by-default settings feature', () => {
        const sessionFolders = getUiFeatureDefinition('sessions.folders');

        expect(sessionFolders.settingsToggle?.showInSettings).toBe(true);
        expect(sessionFolders.settingsToggle?.isExperimental).toBe(false);
        expect(sessionFolders.settingsToggle?.defaultEnabled).toBe(true);
        expect(sessionFolders.settingsToggle?.serverVisibilityScope).toBe('main_selection');
        expect(sessionFolders.settingsToggle?.titleKey).toBe('settingsFeatures.expSessionsFolders');
        expect(sessionFolders.settingsToggle?.subtitleKey).toBe('settingsFeatures.expSessionsFoldersSubtitle');
        expect(sessionFolders.settingsToggle?.icon.ioniconName).toBe('folder-outline');
    });
});

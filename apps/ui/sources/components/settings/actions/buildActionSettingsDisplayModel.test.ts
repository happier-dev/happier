import { describe, expect, it } from 'vitest';

import type { ActionSettingsEntry } from './buildActionSettingsEntries';
import { buildActionSettingsDisplayModel } from './buildActionSettingsDisplayModel';

describe('buildActionSettingsDisplayModel', () => {
    it('keeps only controllable targets inside action sections and moves unavailable targets to the summary list', () => {
        const entry: ActionSettingsEntry = {
            actionId: 'review.start',
            title: 'Review',
            description: 'Start a review',
            enabled: true,
            targets: [
                {
                    id: 'session_action_menu',
                    titleKey: 'settingsActions.targets.session_action_menu.title',
                    subtitleKey: 'settingsActions.targets.session_action_menu.subtitle',
                    icon: 'ellipsis-horizontal',
                    category: 'app',
                    state: 'on',
                    selected: true,
                },
                {
                    id: 'voice_panel',
                    titleKey: 'settingsActions.targets.voice_panel.title',
                    subtitleKey: 'settingsActions.targets.voice_panel.subtitle',
                    icon: 'mic-outline',
                    category: 'voice',
                    state: 'off',
                    selected: false,
                },
                {
                    id: 'run_list',
                    titleKey: 'settingsActions.targets.run_list.title',
                    subtitleKey: 'settingsActions.targets.run_list.subtitle',
                    icon: 'list-outline',
                    category: 'app',
                    state: 'unavailable',
                    selected: false,
                    reasonKey: 'settingsActions.reasons.notAvailableInThisApp',
                },
            ],
        };

        const model = buildActionSettingsDisplayModel([entry]);

        expect(model.entries[0]?.sections).toEqual([
            {
                id: 'app',
                titleKey: 'settingsActions.sections.app',
                targets: [entry.targets[0]],
                selectedIds: ['session_action_menu'],
            },
            {
                id: 'voice',
                titleKey: 'settingsActions.sections.voice',
                targets: [entry.targets[1]],
                selectedIds: [],
            },
        ]);

        expect(model.unavailableEntries).toEqual([
            {
                actionId: 'review.start',
                title: 'Review',
                targets: [entry.targets[2]],
            },
        ]);
    });
});

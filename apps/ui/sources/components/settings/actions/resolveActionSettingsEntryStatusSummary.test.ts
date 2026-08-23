import { describe, expect, it } from 'vitest';
import {
    listActionSettingsEntryStatusParts,
    resolveActionSettingsEntryStatusSummary,
    type ActionSettingsEntryStatusTarget,
} from './resolveActionSettingsEntryStatusSummary';
import { normalizeActionsSettings } from './normalizeActionsSettings';
import { getActionSettingsTargetDefinition } from './actionSettingsTargets';

function target(
    id: ActionSettingsEntryStatusTarget['id'],
    state: ActionSettingsEntryStatusTarget['state'] = 'on',
): ActionSettingsEntryStatusTarget {
    return {
        id,
        state,
        definition: getActionSettingsTargetDefinition('review.start', id),
    };
}

describe('resolveActionSettingsEntryStatusSummary', () => {
    it('counts allowed, ask-first, off, and unavailable target states from one action entry', () => {
        const settings = normalizeActionsSettings({
            v: 1,
            actions: {
                'review.start': {
                    enabledPlacements: [],
                    disabledPlacements: ['command_palette'],
                    disabledSurfaces: [],
                    approvalRequiredSurfaces: ['cli'],
                },
            },
        });

        expect(resolveActionSettingsEntryStatusSummary({
            settings,
            actionId: 'review.start',
            targets: [
                target('cli'),
                target('command_palette'),
                target('mcp', 'unavailable'),
            ],
        })).toEqual({
            allowedCount: 0,
            askFirstCount: 1,
            offCount: 1,
            unavailableCount: 1,
        });
    });

    it('omits unavailable targets from the user-facing compact status by default', () => {
        expect(listActionSettingsEntryStatusParts({
            allowedCount: 1,
            askFirstCount: 0,
            offCount: 1,
            unavailableCount: 6,
        }).map((part) => part.key)).toEqual(['allowedCount', 'offCount']);
    });
});

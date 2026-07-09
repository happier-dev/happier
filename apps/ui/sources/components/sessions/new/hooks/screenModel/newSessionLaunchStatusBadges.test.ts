import { describe, expect, it, vi } from 'vitest';

import { buildNewSessionLaunchStatusBadges } from './newSessionLaunchStatusBadges';

describe('buildNewSessionLaunchStatusBadges', () => {
    it('does not add launch status while the create action is idle', () => {
        expect(buildNewSessionLaunchStatusBadges({
            isCreating: false,
            translate: (key) => key,
        })).toEqual([]);
    });

    it('surfaces launch progress while a spawn request is unresolved', () => {
        const translate = vi.fn((key: string) => key);

        expect(buildNewSessionLaunchStatusBadges({
            isCreating: true,
            translate,
        })).toEqual([{
            key: 'new-session-launch-starting',
            label: 'newSession.startingSession',
            accessibilityLabel: 'newSession.startingSession',
            testID: 'new-session-launch-status',
            tone: 'active',
            emphasis: 'prominent',
        }]);
        expect(translate).toHaveBeenCalledWith('newSession.startingSession');
    });
});

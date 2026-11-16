import { describe, expect, it } from 'vitest';

import { resolveTriggerEditorHref } from './triggerEditorDestination';

describe('trigger editor destination', () => {
    it('opens a saved task trigger in the existing Account trigger editor', () => {
        expect(resolveTriggerEditorHref({ serverId: 'home-a', automationId: 'saved-task-rule' })).toEqual({
            pathname: '/workflows', params: { serverId: 'home-a', trigger: 'saved-task-rule' },
        });
    });
});

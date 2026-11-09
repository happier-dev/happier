import { describe, expect, it } from 'vitest';

import { resolveTriggerEditorHref } from './triggerEditorDestination';

describe('trigger editor destination', () => {
    it('carries a task-born Keep draft into the existing Account trigger editor', () => {
        expect(resolveTriggerEditorHref({ serverId: 'home-a', automationEventSeedId: 'run-source-and-target' })).toEqual({
            pathname: '/workflows', params: { serverId: 'home-a', automationEventSeedId: 'run-source-and-target' },
        });
        expect(resolveTriggerEditorHref({ serverId: 'home-a', automationId: 'saved-task-rule' })).toEqual({
            pathname: '/workflows', params: { serverId: 'home-a', trigger: 'saved-task-rule' },
        });
    });
});

import { describe, expect, it } from 'vitest';
import type { SharedActivityEntry, SharedActivityProjection } from '@/activity/delivery/sharedActivityProjection';
import { buildPetCompanionActivityModel } from './buildPetCompanionActivityModel';
import { petActivityPose } from './petActivityPose';

const ask: SharedActivityEntry = {
    id: 'home/session', dismissKey: 'request-1', address: { serverId: 'home', sessionId: 'session' },
    sessionId: 'session', activity: 'needsYou', title: 'Approval', subtitle: null,
    contextLine: null, accessibilityContext: null,
};
const projection: SharedActivityProjection = { visible: true, activity: 'needsYou', word: 'Needs you', entries: [ask], tray: [ask] };

describe('pet presentation of shared activity', () => {
    it('dismisses only the current attention record without changing its shared activity or later asks', () => {
        const dismissedTrayItemKeys = new Set([ask.dismissKey]);
        const dismissed = buildPetCompanionActivityModel({ projection, dismissedTrayItemKeys });
        expect(dismissed).toMatchObject({ state: 'needsYou', trayItems: [] });
        expect(projection.tray).toEqual([ask]);
        const nextAsk = { ...ask, dismissKey: 'request-2' };
        const next = buildPetCompanionActivityModel({ projection: { ...projection, entries: [nextAsk], tray: [nextAsk] }, dismissedTrayItemKeys });
        expect(next.trayItems.map(item => item.dismissKey)).toEqual(['request-2']);
    });

    it.each(['needsYou', 'working', 'quiet'] as const)('retains shared %s activity when the island owns the tray', activity => {
        const model = buildPetCompanionActivityModel({ projection: { ...projection, activity, entries: [{ ...ask, activity }], tray: [] } });
        expect(model.state).toBe(activity);
        expect(model.trayItems).toEqual([]);
        expect(petActivityPose[model.state]).toBe({ needsYou: 'waiting', working: 'running', quiet: 'idle' }[activity]);
    });
});

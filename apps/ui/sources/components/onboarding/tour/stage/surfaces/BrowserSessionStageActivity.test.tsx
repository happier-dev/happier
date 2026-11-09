import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { DEMO_BROWSER_CONTEXT_SESSION_ID } from '@/demoMode/world/featureSessions';
import { storage } from '@/sync/domains/state/storage';

import { SpotlightTargetScope } from '../useSpotlightTarget';
import { BrowserSessionStageActivity } from './BrowserSessionStageActivity';

const originalState = storage.getState();

afterEach(() => storage.setState(originalState, true));

function seedInactiveBrowserSession() {
    const session = createSessionFixture({
        id: DEMO_BROWSER_CONTEXT_SESSION_ID,
        active: false,
        activeAt: Date.now() - 1_000,
        thinking: false,
    });
    storage.getState().applySessions([session]);
    return session;
}

function ActivityFrame(props: Readonly<{ active: boolean }>) {
    return <SpotlightTargetScope active={props.active}><BrowserSessionStageActivity /></SpotlightTargetScope>;
}

describe('Browser stage activity', () => {
    it('restores the inactive fixture through real lifecycle ordering when the frame unmounts', async () => {
        const baseline = seedInactiveBrowserSession();
        const screen = await renderScreen(<ActivityFrame active />);
        expect(storage.getState().sessions[baseline.id]?.active).toBe(true);
        await screen.unmount();
        expect(storage.getState().sessions[baseline.id]).toMatchObject({
            active: false, activeAt: baseline.activeAt, thinking: false,
        });
    });

    it('activates only the current slot and restores on leave while the Browser surface remains mounted', async () => {
        const baseline = seedInactiveBrowserSession();
        const screen = await renderScreen(<ActivityFrame active={false} />);
        expect(storage.getState().sessions[baseline.id]?.active).toBe(false);
        await screen.update(<ActivityFrame active />);
        expect(storage.getState().sessions[baseline.id]?.active).toBe(true);
        await screen.update(<ActivityFrame active={false} />);
        expect(storage.getState().sessions[baseline.id]).toMatchObject({
            active: false, activeAt: baseline.activeAt, thinking: false,
        });
        await screen.update(<ActivityFrame active />);
        expect(storage.getState().sessions[baseline.id]?.active).toBe(true);
        await screen.unmount();
        expect(storage.getState().sessions[baseline.id]?.active).toBe(false);
    });
});

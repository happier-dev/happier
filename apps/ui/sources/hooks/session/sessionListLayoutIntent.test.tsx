import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

import {
    SessionListLayoutIntentProvider,
    useSessionListLayoutChoice,
    useYieldSessionListLayoutIntent,
} from './sessionListLayoutIntent';

const SAVED_PROJECTS_LAYOUT = {
    sessionListLayoutV1: 'projects',
} as const;

function RecentHost(props: React.PropsWithChildren) {
    return (
        <SessionListLayoutIntentProvider choice="recent_activity">
            {props.children}
        </SessionListLayoutIntentProvider>
    );
}

function useLayoutHostConsumer() {
    return {
        choice: useSessionListLayoutChoice(),
        yieldIntent: useYieldSessionListLayoutIntent(),
    };
}

describe('SessionListLayoutIntentProvider', () => {
    let previousSettings: ReturnType<typeof storage.getState>['settings'];

    beforeEach(() => {
        previousSettings = storage.getState().settings;
        storage.setState({
            settings: { ...previousSettings, ...SAVED_PROJECTS_LAYOUT },
        } as never);
    });

    afterEach(() => {
        standardCleanup();
        storage.setState({ settings: previousSettings } as never);
    });

    it('opens a visit in the host layout and yields it to an explicit choice', async () => {
        const host = await renderHook(useLayoutHostConsumer, { wrapper: RecentHost });

        // Opening /session/recent presents Recent activity even though the Account
        // stores Projects — the intent is a visit initial, never a settings write.
        expect(host.getCurrent().choice).toBe('recent_activity');
        expect(storage.getState().settings.sessionListLayoutV1).toBe('projects');

        // The one explicit-layout writer retires the intent, so the choice the person
        // just made renders here and now rather than only after leaving the route.
        await act(async () => {
            host.getCurrent().yieldIntent();
        });
        await flushHookEffects();

        expect(host.getCurrent().choice).toBe('projects');
        expect(storage.getState().settings.sessionListLayoutV1).toBe('projects');
    });

    it('updates mounted consumers from the single stored preference', async () => {
        const host = await renderHook(useLayoutHostConsumer);
        expect(host.getCurrent().choice).toBe('projects');
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, sessionListLayoutV1: 'recent_activity' } });
        });
        expect(host.getCurrent().choice).toBe('recent_activity');
    });
});

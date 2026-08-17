import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage, storage } from '@/sync/domains/state/storageStore';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';

import { useOpenAttachedSessionTerminal } from './openAttachedSessionTerminal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = 'attached-terminal-subscription-width';

function PaneWrapper(props: React.PropsWithChildren) {
    return <AppPaneProvider>{props.children}</AppPaneProvider>;
}

function seedSession(patch: Record<string, unknown>): void {
    storage.setState((state) => ({
        ...state,
        isDataReady: true,
        sessions: {
            ...state.sessions,
            [SESSION_ID]: {
                id: SESSION_ID,
                seq: 1,
                createdAt: 0,
                updatedAt: 0,
                active: false,
                thinking: false,
                presence: 'online',
                metadata: { path: '', host: '' },
                agentState: null,
                agentStateVersion: 0,
                ...patch,
            } as any,
        },
    }));
}

describe('useOpenAttachedSessionTerminal subscription width', () => {
    let previousState: ReturnType<typeof storage.getState>;

    beforeEach(() => {
        previousState = storage.getState();
    });

    afterEach(() => {
        standardCleanup();
        storage.setState(previousState, true);
    });

    it('keeps its api identity while turn-lifecycle session fields churn', async () => {
        seedSession({ updatedAt: 1, agentStateVersion: 1 });

        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useOpenAttachedSessionTerminal(SESSION_ID);
        }, { wrapper: PaneWrapper });

        // Control: proves the harness observes store notifications at all, so a flat
        // `renders` count below is evidence rather than an inert test.
        let controlRenders = 0;
        await renderHook(() => {
            controlRenders += 1;
            return getStorage()((state) => state.sessions[SESSION_ID]?.agentStateVersion ?? -1);
        });

        const before = hook.getCurrent();
        const rendersBefore = renders;
        const controlBefore = controlRenders;

        // A send bumps exactly these: thinking, agentState identity, agentStateVersion,
        // updatedAt, seq. None of them can change whether the attached terminal is
        // openable, and the header menu compares `onSelectExtraItem` by identity.
        await act(async () => {
            seedSession({ updatedAt: 2, agentStateVersion: 2, thinking: true, seq: 2, agentState: {} });
        });
        await act(async () => {
            seedSession({ updatedAt: 3, agentStateVersion: 3, thinking: true, seq: 3, agentState: {} });
        });

        expect(controlRenders).toBe(controlBefore + 2);
        expect(renders).toBe(rendersBefore);
        expect(hook.getCurrent()).toBe(before);
    });

    it('still reports the session as missing when the record disappears', async () => {
        seedSession({});

        const hook = await renderHook(() => useOpenAttachedSessionTerminal(SESSION_ID), {
            wrapper: PaneWrapper,
        });
        expect(hook.getCurrent().unavailableReason).toBe('session_not_attachable');

        await act(async () => {
            storage.setState((state) => ({ ...state, sessions: {} }));
        });

        expect(hook.getCurrent().unavailableReason).toBe('missing_session');
    });
});

import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const modalSpies = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: modalSpies.alert } }).module;
});

import {
    readLocalServiceActionOutcome,
    useLocalServiceActionRunner,
} from './localServiceActionOutcome';

describe('readLocalServiceActionOutcome', () => {
    it('classifies every failure shape the corridor can actually produce', () => {
        // A guard that never dispatched: no daemon code, still a failure the user must see.
        expect(readLocalServiceActionOutcome(undefined)).toEqual({ kind: 'failed', reasonCode: null });
        // The action-executor front door refusing before the daemon saw it.
        expect(readLocalServiceActionOutcome({ ok: false, errorCode: 'permission_denied' }))
            .toEqual({ kind: 'failed', reasonCode: 'permission_denied' });
        // The daemon refusing, or trying and failing.
        expect(readLocalServiceActionOutcome({ status: 'denied', reasonCode: 'policy_forbids_action' }))
            .toEqual({ kind: 'failed', reasonCode: 'policy_forbids_action' });
        expect(readLocalServiceActionOutcome({ status: 'failed', reasonCode: 'executor_failed' }))
            .toEqual({ kind: 'failed', reasonCode: 'executor_failed' });
    });

    it('does not mistake a success payload for a failure', () => {
        expect(readLocalServiceActionOutcome({ status: 'succeeded' })).toEqual({ kind: 'succeeded' });
        // A launch handler that resolves the opened target, with no envelope at all.
        expect(readLocalServiceActionOutcome({ exposureId: 'exposure-a' })).toEqual({ kind: 'succeeded' });
        expect(readLocalServiceActionOutcome(true)).toEqual({ kind: 'succeeded' });
    });
});

function renderRunner() {
    const value: { current: ReturnType<typeof useLocalServiceActionRunner> | null } = { current: null };
    function Harness() {
        value.current = useLocalServiceActionRunner();
        return React.createElement('View');
    }
    return { value, Harness };
}

describe('useLocalServiceActionRunner', () => {
    afterEach(standardCleanup);
    beforeEach(() => modalSpies.alert.mockReset());

    it('clears the in-flight row through the StrictMode effect replay', async () => {
        // The row spinner is driven by `pendingId`. A mounted-guard that is only ever set to
        // `false` in cleanup never recovers from React's development effect replay, so the row
        // would stay busy forever after an action the user actually completed.
        const { value, Harness } = renderRunner();
        await renderScreen(<React.StrictMode><Harness /></React.StrictMode>);

        let settle!: (result: unknown) => void;
        const dispatched = new Promise<unknown>((resolve) => { settle = resolve; });
        let pending!: Promise<boolean>;
        await act(async () => {
            pending = value.current!.run({
                id: 'row-a:menu',
                failureTitle: 'Could not terminate Vite',
                action: () => dispatched,
            });
            await Promise.resolve();
        });
        expect(value.current?.pendingId).toBe('row-a:menu');

        await act(async () => {
            settle({ status: 'succeeded' });
            await pending;
        });
        expect(value.current?.pendingId).toBeNull();
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });

    it('shows one actionable failure and resolves false when the action is refused', async () => {
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);

        let outcome: boolean | undefined;
        await act(async () => {
            outcome = await value.current?.run({
                id: 'row-a:inline',
                failureTitle: 'Could not start Vite',
                action: async () => ({ status: 'denied', reasonCode: 'policy_forbids_action' }),
            });
        });

        expect(outcome).toBe(false);
        expect(modalSpies.alert).toHaveBeenCalledTimes(1);
        const [title, body] = modalSpies.alert.mock.calls[0] ?? [];
        expect(title).toBe('Could not start Vite');
        // The user gets a sentence, never the daemon's internal code.
        expect(typeof body).toBe('string');
        expect(String(body).length).toBeGreaterThan(0);
        expect(String(body)).not.toContain('policy_forbids_action');
        expect(value.current?.pendingId).toBeNull();
    });

    it('treats a thrown transport error as the same visible failure as a returned refusal', async () => {
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);

        let outcome: boolean | undefined;
        await act(async () => {
            outcome = await value.current?.run({
                id: 'row-a:inline',
                failureTitle: 'Could not open Vite',
                action: async () => { throw new Error('socket closed'); },
            });
        });

        expect(outcome).toBe(false);
        expect(modalSpies.alert).toHaveBeenCalledTimes(1);
        expect(value.current?.pendingId).toBeNull();
    });
});

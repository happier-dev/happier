import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { EntityDropAdmissionV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { Text } from 'react-native';

import { renderScreen } from '@/dev/testkit';
import { createEntityDragDropRuntime } from '../../entityDragDropRuntime';
import { EntityDropSettledFeedback } from '../../ui/EntityDropSettledFeedback';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

const scope = { serverId: 'home-a', accountId: 'account-a' };
const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
});

/** A Session row carried onto a lead whose owner answers later (DnD lab ST4). */
async function lateSettlement(outcome: EntityDropOutcomeV1, options: Readonly<{ webWindow?: EventTarget }> = {}) {
    const runtime = createEntityDragDropRuntime();
    const source = { id: 'source', scope,
        getItem: () => ({ kind: 'session' as const, scope, address: { serverId: scope.serverId, sessionId: 'review' } }),
        isCurrent: () => true, describe: () => ({ title: 'Review #2481' }) };
    const retireSource = runtime.registerSource(source);
    const admission: EntityDropAdmissionV1 = { status: 'allowed', effect: { actionId: 'session.reports_to.set', input: {},
        preview: { verb: 'Put under Fix settings', target: 'Fix settings', consequence: 'Reports to it · both keep running' } } };
    let finish = (_outcome: EntityDropOutcomeV1) => {};
    runtime.registerTarget({ id: 'lead', scope, acceptedKinds: ['session'], getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
        resolve: () => admission, execute: () => new Promise<EntityDropOutcomeV1>(resolve => { finish = resolve; }) });
    const screen = await renderScreen(
        <EntityDropSettledFeedback runtime={runtime} match={{ item: item => item.kind === 'session' && item.address.sessionId === 'review' }} testID="row">
            <Text>Review #2481</Text>
        </EntityDropSettledFeedback>,
    );
    // The browser window is the web interaction boundary; installed only once the row has rendered.
    if (options.webWindow) (globalThis as { window?: unknown }).window = options.webWindow;
    await act(async () => {
        const carry = runtime.begin('source')!;
        carry.move({ x: 50, y: 50 });
        const release = carry.release();
        finish(outcome);
        await release;
    });
    // The owner's source retires and the spring-back finishes: the runtime itself returns to idle.
    await act(async () => { retireSource(); runtime.cancel('feedback-finished'); });
    return { runtime, screen, source };
}

describe('EntityDropSettledFeedback (lab ST4 late refusal)', () => {
    it('keeps the late refusal under its source row after the carry ends, naming verb, target and reason', async () => {
        const { runtime, screen } = await lateSettlement({ status: 'refused', reason: { code: 'changed', message: 'This session was just moved. Try again' } });
        expect(runtime.getSnapshot().phase).toBe('idle');
        const text = screen.getTextContent();
        expect(text).toContain('Couldn’t put Review #2481 under Fix settings');
        expect(text).toContain('This session was just moved. Try again');
        await screen.unmount();
    });

    it('says an unknown result in the same quiet line instead of a blocking alert', async () => {
        const { screen } = await lateSettlement({ status: 'unknown', reason: { code: 'effect-outcome-unknown', message: 'x' } });
        expect(screen.findHostByTestId('row-settled')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Not sure “Put under Fix settings” went through');
        await screen.unmount();
    });

    it('lasts until the next interaction: the next carry dismisses it', async () => {
        const { runtime, screen, source } = await lateSettlement({ status: 'refused', reason: { code: 'changed', message: 'Moved' } });
        expect(screen.findHostByTestId('row-settled')).not.toBeNull();
        await act(async () => { runtime.registerSource(source); runtime.begin('source'); });
        expect(screen.findHostByTestId('row-settled')).toBeNull();
        await act(async () => { runtime.cancel(); });
        expect(screen.findHostByTestId('row-settled')).toBeNull();
        await screen.unmount();
    });

    it('lasts until the next interaction: a press or key anywhere in the window dismisses it on web', async () => {
        const target = new EventTarget();
        const { screen } = await lateSettlement({ status: 'refused', reason: { code: 'changed', message: 'Moved' } }, { webWindow: target });
        expect(screen.findHostByTestId('row-settled')).not.toBeNull();
        await act(async () => { target.dispatchEvent(new Event('keydown')); });
        expect(screen.findHostByTestId('row-settled')).toBeNull();
        await screen.unmount();
    });

    it('leaves other rows and an applied move alone', async () => {
        const { screen } = await lateSettlement({ status: 'applied' });
        expect(screen.findHostByTestId('row-settled')).toBeNull();
        await screen.unmount();
    });
});

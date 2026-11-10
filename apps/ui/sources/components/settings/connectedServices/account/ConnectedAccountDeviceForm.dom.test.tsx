// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createCommittedFiberRenderCounter } from '@/dev/testkit/performance/committedFiberCounts';
import { installSignedOutAuthForTest } from '@/dev/testkit/fixtures/signedOutAuth';

vi.mock('react-native', async () => ({
    ...await vi.importActual('react-native-web'),
    unstable_batchedUpdates: (await import('react-dom')).unstable_batchedUpdates,
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { ConnectedAccountDeviceForm } = await import('./ConnectedAccountDeviceForm');
const { SetupSteps } = await import('@/components/ui/setupBlocks/SetupSteps');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');

it.fails('muse.experience.pc1 commits only the expiry leaf for 60 ticks and leaves static controls quiet', async () => {
    vi.useFakeTimers();
    const restoreAuth = installSignedOutAuthForTest();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const counts = createCommittedFiberRenderCounter();
    const poll = vi.fn();
    const formProps = { verificationUri: 'https://account.example/device', userCode: 'ABCD',
        expiresAtMs: Date.now() + 120_000, onPoll: poll, onResume: vi.fn() };
    const scene = (busy: boolean) => <React.Profiler id="device-code" onRender={() => counts.onCommit(container)}>
        <ConnectedAccountDeviceForm {...formProps} busy={busy} />
    </React.Profiler>;
    try {
        await act(async () => root.render(scene(false)));
        expect(container.querySelector('[data-testid="connected-account-device:open"]')).not.toBeNull();
        expect(container.textContent).toContain('time=2:00');
        // Prove each quiet assertion observes the actual exported component,
        // including anonymous memo components whose bundled names can change.
        counts.start();
        await act(async () => root.render(scene(true)));
        counts.stop();
        for (const component of [ConnectedAccountDeviceForm, SetupSteps, RoundButton]) {
            expect(counts.read().commitsFor(component)).toBeGreaterThan(0);
        }
        await act(async () => root.render(scene(false)));
        counts.start();
        for (let tick = 0; tick < 60; tick++) {
            await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        }
        counts.stop();
        const measured = counts.read();
        expect(container.textContent).toContain('time=1:00');
        expect(measured.commits).toBe(60);
        expect({ form: measured.commitsFor(ConnectedAccountDeviceForm),
            steps: measured.commitsFor(SetupSteps),
            buttons: measured.commitsFor(RoundButton) }).toEqual({ form: 0, steps: 0, buttons: 0 });
        expect(poll).not.toHaveBeenCalled();
    } finally {
        counts.stop();
        await act(async () => root.unmount());
        container.remove();
        restoreAuth();
        vi.useRealTimers();
    }
});

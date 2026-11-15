import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

// Exercise the canonical health classifier and store. Only native rendering is substituted.
const { storage } = await import('@/sync/domains/state/storage');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();
beforeEach(() => {
    previous = storage.getState();
    applied = getAppliedActiveServerSnapshot();
    available = isAppliedActiveServerRuntimeAvailable();
    publishAppliedActiveServerSnapshot({ serverId: 'srv_studio', serverUrl: 'https://studio.example.test', generation: 1 });
    storage.setState({ endpointStatus: 'online', socketStatus: 'connected' });
});
afterEach(async () => {
    await act(async () => {
        standardCleanup();
        storage.setState(previous, true);
        publishAppliedActiveServerSnapshot(applied, available);
    });
});

const { ItemLoadStateRows } = await import('./ItemLoadStateRows');

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/** What the section says, as a reader sees it (the shared notice composes its sentence in nested text). */
function hostTexts(screen: Screen): string {
    return screen.getTextContent();
}

describe('ItemLoadStateRows: a read from the Home this device uses', () => {
    const failedOnStudio = (onRetry: () => void, homeServerIds: readonly string[] = ['srv_studio']) => (
        <ItemLoadStateRows
            testID="retention"
            state={{ kind: 'failed', reason: "Couldn't read this Home's retention policy", onRetry, homeServerIds }}
        />
    );

    it('defers to the page\'s "can\'t reach" banner while that Home is unreachable: no second failure, no second Retry', async () => {
        storage.setState({ endpointStatus: 'offline' });
        const onRetry = vi.fn();
        const screen = await renderScreen(failedOnStudio(onRetry));

        expect(hostTexts(screen)).not.toContain("Couldn't read this Home's retention policy");
        expect(hostTexts(screen)).toContain('sidebarFooter.availableWhenHomeAnswers');
        expect(screen.findHostByTestId('retention-retry')).toBeNull();
    });

    it('reads again by itself once the Home answers, so the banner\'s Retry re-reads every deferred section', async () => {
        storage.setState({ endpointStatus: 'offline' });
        const onRetry = vi.fn();
        const screen = await renderScreen(failedOnStudio(onRetry));
        expect(onRetry).not.toHaveBeenCalled();

        await act(async () => { storage.setState({ endpointStatus: 'online' }); });
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('keeps its own failure and Retry when the Home answers but this read failed, or the read needs another Home', async () => {
        const answered = await renderScreen(failedOnStudio(vi.fn()));
        expect(hostTexts(answered)).toContain("Couldn't read this Home's retention policy");
        expect(answered.findHostByTestId('retention-retry')).not.toBeNull();
        await answered.unmount();

        storage.setState({ endpointStatus: 'offline' });
        const elsewhere = await renderScreen(failedOnStudio(vi.fn(), ['srv_studio', 'srv_lab']));
        expect(hostTexts(elsewhere)).toContain("Couldn't read this Home's retention policy");
        expect(elsewhere.findHostByTestId('retention-retry')).not.toBeNull();
    });
});

describe('ItemLoadStateRows', () => {
    it('reserves the section rows as a busy placeholder while loading, with no "Loading…" text row', async () => {
        const screen = await renderScreen(
            <ItemLoadStateRows testID="pools" state={{ kind: 'loading' }} rows={3} accessibilityLabel="Loading machine pools" />,
        );
        const region = screen.findHostByTestId('pools');
        expect(region?.props.accessibilityState).toEqual({ busy: true });
        expect(region?.props.accessibilityLabel).toBe('Loading machine pools');
        expect(screen.root.findAll((node) => typeof node.type === 'string' && /^pools-skeleton:\d$/.test(String(node.props.testID)))).toHaveLength(3);
        expect(/loading/i.test(hostTexts(screen))).toBe(false);
    });

    it('turns into one row that says what failed, with Retry, when the source fails', async () => {
        const onRetry = vi.fn();
        const screen = await renderScreen(
            <ItemLoadStateRows
                testID="pools"
                state={{ kind: 'failed', reason: "Couldn't read machine pools on Studio", onRetry }}
                rows={3}
                accessibilityLabel="Loading machine pools"
            />,
        );
        expect(hostTexts(screen)).toContain("Couldn't read machine pools on Studio");
        expect(screen.root.findAll((node) => typeof node.type === 'string' && /^pools-skeleton:/.test(String(node.props.testID)))).toHaveLength(0);
        expect(screen.findHostByTestId('pools')?.props.accessibilityState?.busy).not.toBe(true);
        await screen.pressByTestIdAsync('pools-retry');
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    // OWNER-UI-1115B A2: a small failure is drawn one way everywhere, the shared inline notice, never a row of its own
    // with a button (about 77 sections render their failed read through this owner).
    it('says a failed read with the one shared inline notice', async () => {
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const screen = await renderScreen(
            <ItemLoadStateRows testID="pools" state={{ kind: 'failed', reason: "Couldn't read machine pools on Studio", onRetry: () => {} }} />,
        );
        const notices = screen.findAllByType(SurfaceStateCard);
        expect(notices.map((node) => [node.props.size, node.props.kind])).toEqual([['line', 'error']]);
    });

    it('offers no Retry when the failure cannot be retried from here', async () => {
        const screen = await renderScreen(
            <ItemLoadStateRows testID="pools" state={{ kind: 'failed', reason: 'This Home needs an update' }} rows={2} />,
        );
        expect(hostTexts(screen)).toContain('This Home needs an update');
        expect(screen.findHostByTestId('pools-retry')).toBeNull();
    });
});

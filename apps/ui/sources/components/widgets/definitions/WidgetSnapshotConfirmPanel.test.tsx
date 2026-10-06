import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginDeclarativeDocumentV1 } from '@happier-dev/protocol';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

import { createWidgetSnapshotCaptureSlot } from './widgetSnapshotCapture';
import { WidgetSnapshotConfirmPanel } from './WidgetSnapshotConfirmPanel';
import { WidgetFlowPanel } from '../flow/WidgetFlowPanel';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

afterEach(() => standardCleanup());

const DOCUMENT: PluginDeclarativeDocumentV1 = { version: 1, root: { kind: 'metric', label: 'Signups',
    data: { kind: 'value', value: 1284 }, value: { path: [], type: 'number' } } } as PluginDeclarativeDocumentV1;
const SURFACE = { serverId: 'home-a', accountId: 'viewer-a', owner: { kind: 'sessionBoard' as const, sessionId: 'session-a' } };

/**
 * Post a snapshot posts current numbers or none (lab dscope VS). A card that is refreshing, stale or
 * failed is not a dead end: the confirm offers the card's own Refresh, and once the card's reads are
 * current again the frozen preview and Post appear in place.
 */
describe('WidgetSnapshotConfirmPanel', () => {
    it('settles a watched failed refresh, permits a stale retry, then freezes only a current capture', async () => {
        const slot = createWidgetSnapshotCaptureSlot();
        const listeners = new Set<() => void>();
        let current = false;
        let finish: (() => void) | undefined;
        let fail: ((error: Error) => void) | undefined;
        const refresh = vi.fn(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
        slot.register({ read: () => ({ document: DOCUMENT, frozenByPath: new Map(), digests: ['original'], current, refresh }),
            subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } });
        const screen = await renderScreen(<WidgetSnapshotConfirmPanel surface={SURFACE} title="Signups" sourceLabel="replica"
            capture={slot.capture} watch={slot.watch} onDone={() => {}} onCancel={() => {}} testID="retry" />);
        const begin = async () => { await act(async () => { screen.findByTestId('retry.refresh')!.props.onPress(); }); };
        await begin();
        expect(screen.findByTestId('retry.refresh')!.props.disabled).toBe(true);
        await act(async () => { fail!(new Error('read failed')); });
        expect(screen.findByTestId('retry.refresh')!.props.disabled).toBe(false);
        expect(screen.findByTestId('retry.primary')!.props.disabled).toBe(true);
        expect(screen.findByTestId('retry.preview')).toBeNull();
        await begin();
        await act(async () => { finish!(); });
        expect(screen.findByTestId('retry.refresh')!.props.disabled).toBe(false);
        expect(screen.findByTestId('retry.primary')!.props.disabled).toBe(true);
        await begin();
        await act(async () => { current = true; for (const listener of listeners) listener(); finish!(); });
        expect(refresh).toHaveBeenCalledTimes(3);
        expect(screen.findByTestId('retry.preview')).not.toBeNull();
        expect(screen.findByTestId('retry.primary')!.props.disabled).toBe(false);
        // The preview remains the confirmed output after subsequent watch updates.
        await act(async () => { current = false; for (const listener of listeners) listener(); });
        expect(screen.findByTestId('retry.preview')).not.toBeNull();
    });

    it('keeps Cancel reachable as the phone header dismiss for neighboring save and snapshot flows', async () => {
        const dismiss = vi.fn();
        const screen = await renderScreen(<WidgetFlowPanel phone title="Post a snapshot" onCancel={dismiss} testID="phone">{null}</WidgetFlowPanel>);
        expect(screen.findByTestId('phone.cancel')).toBeNull();
        await screen.pressByTestIdAsync('phone.close');
        expect(dismiss).toHaveBeenCalledTimes(1);
    });

    it('refreshes a not-current card from the confirm and freezes the preview once it is current', async () => {
        const slot = createWidgetSnapshotCaptureSlot();
        const listeners = new Set<() => void>();
        let current = false;
        // The mounted card's reads: the Resource refresh is the boundary; it reports current afterwards.
        const refresh = vi.fn(async () => { current = true; for (const listener of listeners) listener(); });
        slot.register({
            read: () => ({ document: DOCUMENT, frozenByPath: new Map(), digests: [], current, refresh }),
            subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        });
        const screen = await renderScreen(<WidgetSnapshotConfirmPanel surface={SURFACE} title="Signups" sourceLabel="analytics replica"
            mark="users" capture={slot.capture} watch={slot.watch} onDone={() => {}} onCancel={() => {}} testID="snap" />);
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('snap.preview')).toBeNull();
        expect(screen.findByTestId('snap.primary')!.props.disabled).toBe(true);

        await screen.pressByTestIdAsync('snap.refresh');
        await flushHookEffects({ cycles: 3 });

        expect(refresh).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('snap.preview')).not.toBeNull();
        expect(screen.findByTestId('snap.primary')!.props.disabled).toBe(false);
    });
});

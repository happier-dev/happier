import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginDeclarativeDocumentV1 } from '@happier-dev/protocol';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { createWidgetSnapshotCaptureSlot, useDeclarativeWidgetSnapshotCapture, WidgetSnapshotCaptureContext } from './widgetSnapshotCapture';
import { WidgetSnapshotConfirmPanel } from './WidgetSnapshotConfirmPanel';
import { WidgetFlowPanel } from '../flow/WidgetFlowPanel';
import { SessionBoardDeclarativeContent } from '@/components/sessions/board/SessionBoardDeclarativeContent';

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
    it('keeps the exact frozen payload through new values and staleness, but withdraws it on disclosure loss', async () => {
        const slot = createWidgetSnapshotCaptureSlot();
        const listeners = new Set<() => void>();
        let readAuthorized = true;
        let current = true;
        let document = DOCUMENT;
        slot.register({ read: () => ({ document, frozenByPath: new Map(), digests: [], readIdentity: 'same-read', readAuthorized,
            current, refresh: async () => {} }), subscribe: listener => {
            listeners.add(listener); return () => { listeners.delete(listener); };
        } });
        const screen = await renderScreen(<WidgetSnapshotConfirmPanel surface={SURFACE} title="Signups" sourceLabel="replica"
            capture={slot.capture} watch={slot.watch} onDone={() => {}} onCancel={() => {}} testID="frozen" />);
        const approved = screen.tree.root.findByType(SessionBoardDeclarativeContent).props.document;
        await act(async () => {
            document = { version: 1, root: { kind: 'text', text: 'New value' } };
            current = false;
            for (const listener of listeners) listener();
        });
        expect(screen.tree.root.findByType(SessionBoardDeclarativeContent).props.document).toBe(approved);
        expect(screen.findByTestId('frozen.primary')!.props.disabled).toBe(false);
        await act(async () => { readAuthorized = false; for (const listener of listeners) listener(); });
        expect(screen.findByTestId('frozen.preview')).toBeNull();
        expect(screen.findByTestId('frozen.primary')!.props.disabled).toBe(true);
    });
    it('keeps capture available while the mounted document updates its shown value', async () => {
        const slot = createWidgetSnapshotCaptureSlot();
        const availability: boolean[] = [];
        const stop = slot.subscribe(() => availability.push(slot.isAvailable()));
        function Card({ value }: Readonly<{ value: number }>) {
            useDeclarativeWidgetSnapshotCapture(() => ({
                document: { version: 1, root: { kind: 'metric', label: 'Files', data: { kind: 'value', value }, value: { path: [], type: 'number' } } },
                frozenByPath: new Map(), digests: [], readIdentity: 'files', readAuthorized: true, current: true, refresh: async () => {},
            }));
            return null;
        }
        const renderCard = (value: number) => <WidgetSnapshotCaptureContext.Provider value={slot}><Card value={value} /></WidgetSnapshotCaptureContext.Provider>;
        const screen = await renderScreen(renderCard(17));
        expect(slot.isAvailable()).toBe(true);
        availability.length = 0;
        await screen.update(renderCard(23));
        expect(availability).not.toContain(false);
        expect(slot.capture()?.document.root).toMatchObject({ data: { value: 23 } });
        await screen.unmount();
        expect(slot.isAvailable()).toBe(false);
        stop();
    });

    it('settles a watched failed refresh, permits a stale retry, then freezes only a current capture', async () => {
        const slot = createWidgetSnapshotCaptureSlot();
        const listeners = new Set<() => void>();
        let current = false;
        let finish: (() => void) | undefined;
        let fail: ((error: Error) => void) | undefined;
        const refresh = vi.fn(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
        slot.register({ read: () => ({ document: DOCUMENT, frozenByPath: new Map(), digests: ['original'], readIdentity: 'signups', readAuthorized: true, current, refresh }),
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
});

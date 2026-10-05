import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrentSessionPresentationActionInputV1Schema } from '@happier-dev/protocol/sessions';

import { findGestureByKind } from '@/dev/testkit/mocks/gestureHandler';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import { resolveSessionCompanionEntityDrop } from '@/components/sessions/board/sessionSurfaceEntityDrop';
import type { SessionSurfaceEntityBinding } from '@/components/sessions/board/SessionSurfaceEntityDrag';
import { moveSessionCompanionItem, normalizeSessionCompanionPreference, sessionCompanionItemKey } from './state/sessionCompanionPreference';
import { SessionCompanionItemFrame } from './SessionCompanionItemFrame';

vi.mock('react-native', async () => (
    await import('@/dev/testkit/mocks/reactNative')
).createReactNativeWebMock());

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

const SCOPE = { serverId: 'home-1', accountId: 'account-1' };
const ADDRESS = { serverId: SCOPE.serverId, sessionId: 'session-1' };
const SUMMARY = { kind: 'builtin' as const, id: 'session_summary' as const };
const INITIAL_KEYS = ['builtin:session_summary', 'widget:a', 'widget:b'];
const DESTINATION = { side: 'after' as const, itemKey: 'widget:b' };

function keyEvent(key: string) {
    return { key, nativeEvent: { key }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

async function renderFrame() {
    const runtime = (await renderHook(() => useEntityDragDropRuntime())).getCurrent();
    let preference = normalizeSessionCompanionPreference({
        v: 1, visible: true, collapsed: false, edge: 'trailing', density: 'compact',
        items: [SUMMARY, { kind: 'widget', widgetId: 'a' }, { kind: 'widget', widgetId: 'b' }],
    });
    const retire = runtime.registerTarget({
        id: 'companion-reorder', scope: SCOPE, acceptedKinds: ['companion-item'],
        getBounds: () => ({ x: 0, y: 220, width: 300, height: 100 }),
        listDestinations: () => [{ destination: DESTINATION, label: 'After second widget' }],
        resolve: ({ item }) => resolveSessionCompanionEntityDrop({
            item, scope: SCOPE, address: ADDRESS, board: null, items: preference.items, ready: true,
            anchor: DESTINATION, preview: { verb: 'Move after', target: 'Second widget' },
        }),
        execute: async effect => {
            const input = CurrentSessionPresentationActionInputV1Schema.parse(effect.input);
            if (input.intent.kind !== 'companion.item.move') throw new Error('Expected Companion order effect');
            preference = moveSessionCompanionItem(preference, input.intent.item, input.intent.toIndex);
            return { status: 'applied' };
        },
    });
    const entityDrag: SessionSurfaceEntityBinding = {
        scope: SCOPE, isCurrent: () => true, title: 'Session summary',
        getItem: () => ({ kind: 'companion-item', scope: SCOPE, address: ADDRESS, item: SUMMARY }),
        keyboardDestination: (_intent, _selected, destinations) => destinations[0] ?? null,
    };
    const screen = await renderScreen(
        <SessionCompanionItemFrame testID="companion-item" label="Session summary" actions={[]} entityDrag={entityDrag}>
            {(accessory) => accessory}
        </SessionCompanionItemFrame>,
    );
    const pan = findGestureByKind(screen.tree.root.findByType('GestureDetector' as never).props.gesture, 'pan');
    return {
        screen, pan, runtime,
        keys: () => preference.items.map(sessionCompanionItemKey),
        dispose: async () => { await act(async () => { retire(); runtime.cancel(); }); },
    };
}

describe('SessionCompanionItemFrame shared-runtime reorder', () => {
    beforeEach(() => { standardCleanup(); });

    it.each(['pointer', 'keyboard'] as const)('applies the same current Companion order from %s release', async input => {
        const frame = await renderFrame();
        try {
            const handle = () => frame.screen.findHostByTestId('companion-item-move-handle');
            expect(frame.pan).not.toBeNull();
            await act(async () => {
                if (input === 'pointer') {
                    frame.pan?.__handlers.onStart?.({ absoluteX: 150, absoluteY: 50 });
                    frame.pan?.__handlers.onUpdate?.({ absoluteX: 150, absoluteY: 290 });
                } else {
                    handle()?.props.onKeyDown?.(keyEvent(' '));
                    handle()?.props.onKeyDown?.(keyEvent('ArrowDown'));
                }
            });
            expect(frame.keys()).toEqual(INITIAL_KEYS);
            expect(frame.runtime.getSnapshot().admission?.status).toBe('allowed');
            await act(async () => {
                if (input === 'pointer') {
                    frame.pan?.__handlers.onEnd?.({ absoluteX: 150, absoluteY: 290 }, true);
                    frame.pan?.__handlers.onFinalize?.();
                } else handle()?.props.onKeyDown?.(keyEvent('Enter'));
            });
            expect(frame.keys()).toEqual(['widget:a', 'widget:b', 'builtin:session_summary']);
        } finally { await frame.dispose(); }
    });

    it('preserves the Companion order when the system takes the pointer away', async () => {
        const frame = await renderFrame();
        try {
            await act(async () => {
                frame.pan?.__handlers.onStart?.({ absoluteX: 150, absoluteY: 50 });
                frame.pan?.__handlers.onUpdate?.({ absoluteX: 150, absoluteY: 290 });
            });
            expect(frame.runtime.getSnapshot().admission?.status).toBe('allowed');
            await act(async () => {
                frame.pan?.__handlers.onEnd?.({ absoluteX: 150, absoluteY: 290 }, false);
                frame.pan?.__handlers.onFinalize?.();
            });
            expect(frame.keys()).toEqual(INITIAL_KEYS);
            expect(frame.runtime.getSnapshot().phase).toBe('idle');
        } finally { await frame.dispose(); }
    });

    it('publishes no reorder affordance when its owner supplies no binding', async () => {
        const screen = await renderScreen(
            <SessionCompanionItemFrame testID="companion-item" label="Session summary" actions={[]}>
                {(accessory) => accessory}
            </SessionCompanionItemFrame>,
        );
        expect(screen.findHostByTestId('companion-item-move-handle')).toBeNull();
    });
});

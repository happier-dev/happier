import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionItemRowViewModel } from './sessionItemRowViewModelTestFixture';
import { SessionListStagedMoveProvider } from './keyboardMove/SessionListStagedMoveDock';
import { SessionListRow } from './sessionListRow';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});
vi.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args) }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

describe('SessionListRow keyboard carry', () => {
    afterEach(standardCleanup);
    it('lets nested row controls keep Space and Enter while the primary row can stage a move', async () => {
        const session = createSessionFixture({ id: 'sess_keyboard', serverId: 'server_a' });
        const handleRowKey = vi.fn(() => true);
        const screen = await renderScreen(
            <InjectedAuthProvider credentials={{ token: 'test-token' }}>
            <SessionListStagedMoveProvider handleRowKey={handleRowKey}>
                <SessionListRow session={session} rowViewModel={createSessionItemRowViewModel({ session })}
                    selected={false} isFirst isLast variant="default" compact={false}
                    sessionKey="sess_keyboard" treeRowId="sess_keyboard" groupKey="group" reorderEnabled organizeMode={false}
                    onDragStart={vi.fn()} onDropResult={vi.fn()}
                    resolveDropResult={() => ({ result: { instruction: { kind: 'idle' }, visual: { kind: 'none' } }, geometry: { kind: 'none' } })}
                    onTogglePinnedSessionKey={null} onSetTagsSessionKey={null} onNativeContextMenuOpenChangeSessionKey={null}
                    isDragActive={false} isBeingDragged={false} dataIndex={0}
                    overlayShared={{ overlayVisible: { value: 0 }, overlayKind: { value: 0 }, overlayTop: { value: 0 },
                        overlayHeight: { value: 0 }, overlayLeft: { value: 0 }, overlayRight: { value: 0 }, overlayDepth: { value: 0 } }}
                    onRegisterTreeRowBounds={vi.fn()} onUnregisterTreeRowBounds={vi.fn()} />
            </SessionListStagedMoveProvider>
            </InjectedAuthProvider>,
        );
        const row = screen.root.findAll((node) => typeof node.type === 'string' && typeof node.props.onKeyDownCapture === 'function')[0]!;
        // DOM boundary: closest identifies the focused control; the first primary action is the row surface.
        const primary = { matches: () => false };
        const secondary = { matches: () => false };
        const currentTarget = { querySelector: () => primary };
        for (const key of [' ', 'Enter']) {
            const event = { key, nativeEvent: { target: { closest: () => secondary } }, currentTarget, preventDefault: vi.fn(), stopPropagation: vi.fn() };
            row.props.onKeyDownCapture(event);
            expect(handleRowKey).not.toHaveBeenCalled();
            expect(event.preventDefault).not.toHaveBeenCalled();
        }
        const event = { key: ' ', nativeEvent: { target: { closest: () => primary } }, currentTarget, preventDefault: vi.fn(), stopPropagation: vi.fn() };
        row.props.onKeyDownCapture(event);
        expect(handleRowKey).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: 'sess_keyboard', key: ' ' }));
        expect(event.preventDefault).toHaveBeenCalled();
    });
});

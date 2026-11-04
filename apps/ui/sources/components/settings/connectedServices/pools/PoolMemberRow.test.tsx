import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

const platformState = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' | 'android' }));
installSettingsViewCommonModuleMocks({
    storage: 'real',
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: {
            get OS() { return platformState.os; },
            select: (values: Record<string, unknown>) => values[platformState.os] ?? values.default,
        } });
    },
});
afterEach(() => { platformState.os = 'web'; });
const { PoolMemberRow } = await import('./PoolMemberRow');

describe('Pool member leading controls', () => {
    it('keeps the reorder handle outside the compact row button', async () => {
        const { Pressable } = await import('react-native');
        const screen = await renderScreen(<PoolMemberRow testID="member" title="Personal" identityLabel="me@example.com" active={false} enabled note={null} usage={{ kind: 'none' }} now={0}
            onMakeActive={() => {}} onEnabledChange={null} onOpen={null}
            actions={[{ id: 'remove', title: 'Remove member', icon: 'trash', onPress() {} }]}
            reorderHandle={<Pressable testID="member:handle" accessibilityRole="button" accessibilityLabel="Move Personal" />} />);
        const measure = screen.root.findAll((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function')[0];
        act(() => measure.props.onLayout({ nativeEvent: { layout: { width: 340, height: 80, x: 0, y: 0 } } }));
        const row = screen.findHostByTestId('member');
        expect(row?.type).toBe('Pressable');
        // Each control is its own activation target: none sits inside the row's own button (no nested
        // interactive elements for assistive technology, and no <button> inside <button> on the web).
        const insideRow = ['member:handle'].filter((id) => {
            let ancestor = screen.findHostByTestId(id)?.parent;
            while (ancestor) {
                if (ancestor === row) return true;
                ancestor = ancestor.parent;
            }
            return false;
        });
        expect(screen.findHostByTestId('member:handle')).toBeTruthy();
        expect(insideRow).toEqual([]);
    });
});

describe('Pool member row anatomy', () => {
    it('carries two controls on the row (switch and ⋯); the row opens the account and Make active lives in ⋯', async () => {
        await withPopoverWebGlobals(async () => {
            const onOpen = vi.fn();
            const onMakeActive = vi.fn();
            const screen = await renderScreen(<PoolMemberRow testID="member" title="Personal" identityLabel="me@example.com" active={false} enabled note={null} usage={{ kind: 'none' }} now={0}
                onMakeActive={onMakeActive} onEnabledChange={() => {}} onOpen={onOpen}
                actions={[{ id: 'remove', title: 'Remove member', icon: 'trash', onPress() {} }]} />);
            const measure = screen.root.findAll((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function')[0];
            act(() => measure.props.onLayout({ nativeEvent: { layout: { width: 900, height: 80, x: 0, y: 0 } } }));
            expect(screen.findHostByTestId('member:active-radio')).toBeNull();
            expect(screen.findHostByTestId('member:open')).toBeNull();
            expect(screen.findByTestId('member:enabled')).toBeTruthy();
            expect(screen.findByTestId('member:actions-menu')).toBeTruthy();
            act(() => screen.findHostByTestId('member')?.props.onPress());
            expect(onOpen).toHaveBeenCalledTimes(1);
            // Narrow, the ⋯ trigger gives way to the row's own context menu; the actions are the same.
            act(() => measure.props.onLayout({ nativeEvent: { layout: { width: 340, height: 80, x: 0, y: 0 } } }));
            act(() => screen.findHostByTestId('member')?.props.onContextMenu({ preventDefault() {} }));
            const makeActive = screen.root.findAll((node) => typeof node.type === 'string' && /make.?active/i.test(String(node.props.accessibilityLabel ?? '')))[0];
            expect(makeActive).toBeTruthy();
            await act(async () => makeActive.props.onPress());
            expect(onMakeActive).toHaveBeenCalledTimes(1);
        });
    });
});

describe('Pool member compact actions', () => {
    it.each(['ios', 'android'] as const)('retains long press in a wide native phone layout (%s)', async (platform) => {
        platformState.os = platform;
        const screen = await renderScreen(<PoolMemberRow testID="member" title="Personal" identityLabel={null} active enabled note={null} usage={{ kind: 'none' }} now={0} onMakeActive={null} onEnabledChange={null} onOpen={null} actions={[{ id: 'remove', title: 'Remove member', icon: 'trash', onPress() {} }]} />);
        expect(screen.findHostByTestId('member')?.props.onLongPress).toBeTypeOf('function');
    });

    it('opens member actions on a stationary phone long press', async () => {
        await withPopoverWebGlobals(async () => {
            const screen = await renderScreen(<PoolMemberRow testID="member" title="Personal" identityLabel={null} active enabled note={null} usage={{ kind: 'none' }} now={0} onMakeActive={null} onEnabledChange={null} onOpen={null} actions={[{ id: 'remove', title: 'Remove member', icon: 'trash', onPress() {} }]} />);
            const measure = screen.root.findAll((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function')[0];
            act(() => measure.props.onLayout({ nativeEvent: { layout: { width: 340, height: 80, x: 0, y: 0 } } }));
            const row = screen.findHostByTestId('member');
            expect(row?.props.onLongPress).toBeTypeOf('function');
            act(() => row?.props.onLongPress());
            expect(screen.root.findAll((node) => typeof node.type === 'string' && node.props.accessibilityLabel === 'Remove member')).not.toHaveLength(0);
        });
    });

    it('offers context actions after the compact menu control disappears without making a nested row button', async () => {
        await withPopoverWebGlobals(async () => {
            let removed = false;
            const screen = await renderScreen(<PoolMemberRow testID="member" title="Personal" identityLabel="me@example.com" active enabled note={null} usage={{ kind: 'none' }} now={0} onMakeActive={null} onEnabledChange={null} onOpen={null} actions={[{ id: 'remove', title: 'Remove member', icon: 'trash', onPress: () => { removed = true; } }]} />);
            const measure = screen.root.findAll((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function')[0];
            act(() => measure.props.onLayout({ nativeEvent: { layout: { width: 340, height: 80, x: 0, y: 0 } } }));
            expect(screen.findHostByTestId('member:actions-menu')).toBeNull();
            const row = screen.findHostByTestId('member');
            expect(row?.type).toBe('Pressable');
            // The primary long-press target and enabled switch remain siblings.
            let ancestor = screen.findHostByTestId('member:enabled')?.parent;
            while (ancestor) {
                expect(ancestor).not.toBe(row);
                ancestor = ancestor.parent;
            }
            act(() => row?.props.onContextMenu({ preventDefault() {} }));
            const action = screen.root.findAll((node) => typeof node.type === 'string' && node.props.accessibilityLabel === 'Remove member')[0];
            expect(action).toBeTruthy();
            await act(async () => action.props.onPress());
            expect(removed).toBe(true);
        });
    });
});

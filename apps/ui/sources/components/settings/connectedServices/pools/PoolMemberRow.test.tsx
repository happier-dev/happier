import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

const platformState = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' | 'android' }));
installSettingsViewCommonModuleMocks({
    storage: (importOriginal) => importOriginal(),
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

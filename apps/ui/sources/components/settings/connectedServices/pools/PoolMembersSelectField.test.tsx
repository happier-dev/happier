import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { Popover } from '@/components/ui/popover';
import { reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks();
const { PoolMembersSelectField } = await import('./PoolMembersSelectField');

describe('Pool members menu', () => {
    it('opens Connect from the menu trigger without changing pool members', async () => {
        await withPopoverWebGlobals(async () => {
            const commit = vi.fn();
            const connect = vi.fn();
            const screen = await renderScreen(<PoolMembersSelectField testID="members" candidates={[{ accountId: 'one', title: 'Personal' }]} selectedAccountIds={['one']} onCommit={commit} onConnectAccount={connect} open renderTrigger={() => React.createElement('View')} />);
            await act(async () => reportPopoverContentLayout(screen, { width: 320, height: 280 }));
            const menuTriggerRef = screen.root.findByType(Popover).props.anchorRef;
            if (!menuTriggerRef) throw new Error('Expected menu trigger anchor');
            const trigger = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 80, height: 32 }) };
            await act(async () => { screen.findHostByTestId('members:connect')!.props.onPress({ currentTarget: trigger }); });
            expect(connect).toHaveBeenCalledWith({ kind: 'view', ref: menuTriggerRef });
            expect(menuTriggerRef.current).not.toBe(trigger);
            expect(commit).not.toHaveBeenCalled();
        });
    });
    it('commits the current draft when Done closes the menu and keeps connecting separate', async () => {
        await withPopoverWebGlobals(async () => {
            const commit = vi.fn();
            const connect = vi.fn();
            const screen = await renderScreen(<PoolMembersSelectField testID="members" candidates={[{ accountId: 'one', title: 'Personal', subtitle: 'me@example.com · Pro' }, { accountId: 'two', title: 'Work' }]} selectedAccountIds={['one']} onCommit={commit} onConnectAccount={connect} open renderTrigger={() => React.createElement('View')} />);
            await act(async () => reportPopoverContentLayout(screen, { width: 320, height: 280 }));
            await screen.pressByTestIdAsync('qualified-connected-account-group:members:option:two');
            expect(commit).not.toHaveBeenCalled();
            await screen.pressByTestIdAsync('members:done');
            expect(commit).toHaveBeenCalledWith(['one', 'two']);
            expect(connect).not.toHaveBeenCalled();
        });
    });
});

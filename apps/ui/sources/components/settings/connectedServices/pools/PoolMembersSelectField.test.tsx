import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks();
const { PoolMembersSelectField } = await import('./PoolMembersSelectField');

describe('Pool members menu', () => {
    it('commits the current draft when Done closes the menu and keeps connecting separate', async () => {
        await withPopoverWebGlobals(async () => {
            const commit = vi.fn();
            const connect = vi.fn();
            const screen = await renderScreen(<PoolMembersSelectField testID="members" candidates={[{ accountId: 'one', title: 'Personal', subtitle: 'me@example.com · Pro' }, { accountId: 'two', title: 'Work' }]} selectedAccountIds={['one']} onCommit={commit} onConnectAccount={connect} open renderTrigger={() => React.createElement('View')} />);
            await screen.pressByTestIdAsync('qualified-connected-account-group:members:option:two');
            expect(commit).not.toHaveBeenCalled();
            await screen.pressByTestIdAsync('members:done');
            expect(commit).toHaveBeenCalledWith(['one', 'two']);
            expect(connect).not.toHaveBeenCalled();
        });
    });
});

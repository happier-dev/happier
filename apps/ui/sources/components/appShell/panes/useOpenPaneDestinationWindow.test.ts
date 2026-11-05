import { describe, expect, it } from 'vitest';
import { resolvePaneDestinationWindowAddress } from './useOpenPaneDestinationWindow';
import { selectedPaneDestinationTabKey } from './model/selectedPaneDestination';
import type { AppWindowRecord } from '@/desktop/window/appWindowBoot';

describe('pane window command address', () => {
    it('keeps the source layout for recipient pane commands instead of using the destination window layout', () => {
        const tabKey = selectedPaneDestinationTabKey('bottom');
        const record = { windowId: 'pane-window', homeId: 'home', accountId: 'account', layoutId: 'recipient-layout',
            selectedAddress: { kind: 'paneTab', layoutId: 'source-layout', scopeId: 'scope', tabKey } } satisfies AppWindowRecord;
        expect(resolvePaneDestinationWindowAddress({ serverId: 'home', accountId: 'account', layoutId: 'recipient-layout' },
            record, 'scope', tabKey)).toEqual({ kind: 'paneTab', serverId: 'home', accountId: 'account', layoutId: 'source-layout', scopeId: 'scope', tabKey });
    });
});

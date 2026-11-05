import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { DestinationInstanceContext, type DestinationInstanceContextValue } from './destinationInstanceContext';
import { useDestinationInstanceKey, useDestinationRouter } from './DestinationInstanceHost';

describe('destination router locality', () => {
    it('keeps router and identity readers still when the destination only gains or loses focus', async () => {
        const navigation = { push: vi.fn(), replace: vi.fn(), back: vi.fn() };
        const base = { tabId: 'tab-a', ref: { kind: 'store', params: {} }, pathname: '/store', isFocused: () => true, navigation };
        let routerRenders = 0;
        let keyRenders = 0;
        // An approvals/registry read binds the router only to open a destination later.
        function RouterReader() { useDestinationRouter(); routerRenders += 1; return null; }
        function KeyReader() { useDestinationInstanceKey(); keyRenders += 1; return null; }
        const children = <><RouterReader /><KeyReader /></>;
        const tree = (value: DestinationInstanceContextValue) => <DestinationInstanceContext.Provider value={value}>{children}</DestinationInstanceContext.Provider>;
        const screen = await renderScreen(tree({ ...base, focused: true, visible: true }));
        const before = { routerRenders, keyRenders };

        await screen.update(tree({ ...base, focused: false, visible: true }));
        await screen.update(tree({ ...base, focused: false, visible: false }));

        expect({ routerRenders, keyRenders }).toEqual(before);
    });

});

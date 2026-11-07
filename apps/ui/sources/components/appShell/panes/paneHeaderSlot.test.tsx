import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import {
    PaneHeaderSlotHandleProvider,
    PaneHeaderSlotProvider,
    PaneHeaderSlotScope,
    usePaneHeaderSlotContent,
    usePaneHeaderSlotHandle,
    usePublishedPaneHeaderContent,
    type PaneHeaderSlotHandle,
} from './paneHeaderSlot';

describe('PaneHeaderSlotHandleProvider', () => {
    it('lands a retained body on its pane header and never remounts it when the presentation drops the slot', async () => {
        const mounted = vi.fn();
        const content = { menuActions: [] };
        let published: ReturnType<typeof usePublishedPaneHeaderContent> = null;
        let handle: PaneHeaderSlotHandle = null;
        function Header() { published = usePublishedPaneHeaderContent('browser'); return null; }
        function Capture() { handle = usePaneHeaderSlotHandle(); return null; }
        function Body() {
            React.useEffect(() => { mounted(); }, []);
            usePaneHeaderSlotContent(content);
            return null;
        }
        const tree = (forwarded: PaneHeaderSlotHandle) => (
            <PaneHeaderSlotProvider>
                <Header />
                <PaneHeaderSlotScope slotKey="browser"><Capture /></PaneHeaderSlotScope>
                {/* Outside the scope, as a retained viewer source mounts it. */}
                <PaneHeaderSlotHandleProvider handle={forwarded}><Body /></PaneHeaderSlotHandleProvider>
            </PaneHeaderSlotProvider>
        );
        const screen = await renderScreen(tree(null));
        await screen.update(tree(handle));
        expect(published).toEqual(content);
        await screen.update(tree(null));
        expect(published).toBeNull();
        expect(mounted).toHaveBeenCalledTimes(1);
    });
});

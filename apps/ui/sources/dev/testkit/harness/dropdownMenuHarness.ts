import { act } from 'react-test-renderer';
import { expect } from 'vitest';

import type { renderScreen } from '@/dev/testkit/render/renderScreen';

type MenuNode = Readonly<{ props: Readonly<{
    items: ReadonlyArray<Readonly<{ id: string }>>;
    onOpenChange: (open: boolean) => void;
    onSelect: (id: string) => void;
}> }>;

/**
 * Opens the menu owning `triggerTestID` and chooses `itemId` through the menu's own open/select contract.
 * A `DropdownMenu` opens in a positioned popover whose placement is a platform boundary in unit tests;
 * this keeps the item list and the selection handler real.
 */
export async function chooseDropdownMenuItem(screen: Awaited<ReturnType<typeof renderScreen>>, triggerTestID: string, itemId: string) {
    const menu = () => screen.tree.root.findAll((node) => typeof node.props?.onOpenChange === 'function' && Array.isArray(node.props?.items)
        && typeof node.props?.onSelect === 'function' && node.findAll((child) => child.props?.testID === triggerTestID).length > 0)[0] as unknown as MenuNode | undefined;
    expect(menu(), triggerTestID).toBeTruthy();
    // The open popover's placement listens to the browser window, which a web-mode unit test lacks.
    const hadWindow = 'window' in globalThis;
    if (!hadWindow) Object.assign(globalThis, { window: { addEventListener: () => {}, removeEventListener: () => {} } });
    try {
        await act(async () => { menu()!.props.onOpenChange(true); });
        expect(menu()!.props.items.map((item) => item.id)).toContain(itemId);
        await act(async () => { menu()!.props.onSelect(itemId); });
        await act(async () => { menu()?.props.onOpenChange(false); });
    } finally {
        if (!hadWindow) delete (globalThis as { window?: unknown }).window;
    }
}

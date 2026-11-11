import { describe, expect, it, vi } from 'vitest';

import { openEmbeddedToolInDockLocation, toggleEmbeddedTerminalInDockLocation } from './embeddedTerminalDocking';

describe('toggleEmbeddedTerminalInDockLocation', () => {
    it('opens a Project terminal in the bottom pane through the shared docking owner', () => {
        const pane = {
            openBottom: vi.fn(),
            setBottomTab: vi.fn(),
            closeBottom: vi.fn(),
            openRight: vi.fn(),
            setRightTab: vi.fn(),
            closeRight: vi.fn(),
            closeDetails: vi.fn(),
        };

        toggleEmbeddedTerminalInDockLocation({
            pane,
            dockLocation: 'bottom',
            bottomTerminalActive: false,
            rightTerminalActive: false,
            rightPaneHiddenByDetails: false,
        });

        expect(pane.openBottom).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(pane.setBottomTab).toHaveBeenCalledWith('terminal');
        expect(pane.closeBottom).not.toHaveBeenCalled();
        expect(pane.openRight).not.toHaveBeenCalled();
    });
});

describe('openEmbeddedToolInDockLocation', () => {
    it('opens Browser in the Details pane', () => {
        const pane = {
            openDetailsTab: vi.fn(),
            openRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            setBottomTab: vi.fn(),
        };

        openEmbeddedToolInDockLocation({ pane, tool: 'browser' });

        expect(pane.openDetailsTab).toHaveBeenCalledWith(expect.objectContaining({ kind: 'browser-view' }), { intent: 'pinned' });
        expect(pane.openRight).not.toHaveBeenCalled();
    });
});

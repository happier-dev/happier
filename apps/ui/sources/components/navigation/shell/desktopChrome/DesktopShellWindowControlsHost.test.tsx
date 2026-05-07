import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { DesktopShellWindowControlsHost } from './DesktopShellWindowControlsHost';
import { DesktopWindowControlsSlot } from './DesktopWindowControlsSlot';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('DesktopShellWindowControlsHost', () => {
    it('renders nothing when no window-controls surface is active', async () => {
        const screen = await renderScreen(<DesktopShellWindowControlsHost />);

        expect(screen.findAllByTestId('desktop-window-controls-host')).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-window-controls-slot')).toHaveLength(0);
    });

    it('wraps an active window-controls surface in a host and slot', async () => {
        const screen = await renderScreen(
            <DesktopShellWindowControlsHost>
                <React.Fragment />
            </DesktopShellWindowControlsHost>,
        );

        expect(screen.findAllByTestId('desktop-window-controls-host')).toHaveLength(1);
        expect(screen.findAllByTestId('desktop-window-controls-slot')).toHaveLength(1);
    });

    it('does not wrap an already resolved window-controls slot in another slot', async () => {
        const screen = await renderScreen(
            <DesktopShellWindowControlsHost>
                <DesktopWindowControlsSlot>
                    <React.Fragment />
                </DesktopWindowControlsSlot>
            </DesktopShellWindowControlsHost>,
        );

        expect(screen.findAllByTestId('desktop-window-controls-host')).toHaveLength(1);
        expect(screen.findAllByTestId('desktop-window-controls-slot')).toHaveLength(1);
        expect(screen.findAllByTestId('desktop-window-drag-region')).toHaveLength(1);
    });
});

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { DesktopShellWindowControlsHost } from './DesktopShellWindowControlsHost';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('DesktopShellWindowControlsHost', () => {
    it('renders nothing when no window-controls surface is active', async () => {
        const screen = await renderScreen(<DesktopShellWindowControlsHost />);

        expect(screen.findAllByTestId('desktop-window-controls-host')).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-window-controls-slot')).toHaveLength(0);
    });

    it('renders the host wrapper when an active window-controls surface is provided', async () => {
        const screen = await renderScreen(
            <DesktopShellWindowControlsHost>
                <React.Fragment>
                    <></>
                </React.Fragment>
            </DesktopShellWindowControlsHost>,
        );

        expect(screen.findAllByTestId('desktop-window-controls-host')).toHaveLength(1);
        expect(screen.findAllByTestId('desktop-window-controls-slot')).toHaveLength(1);
    });
});

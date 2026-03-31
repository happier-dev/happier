import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

describe('WebDesktopHandoffStep', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('includes guided desktop handoff steps for hosting a relay on this computer', async () => {
        const { WebDesktopHandoffStep } = await import('./WebDesktopHandoffStep');
        const screen = await renderScreen(React.createElement(WebDesktopHandoffStep, {
            testID: 'web-desktop-handoff',
        }));

        expect(screen.findByTestId('web-desktop-handoff')).toBeTruthy();
        expect(screen.findByTestId('web-desktop-handoff-download-desktop')).toBeTruthy();
        expect(screen.findByTestId('web-desktop-handoff-terminal')).toBeTruthy();

        expect(screen.findByTestId('web-desktop-handoff-terminal-step-cli-install')).toBeTruthy();
        expect(screen.findByTestId('web-desktop-handoff-terminal-step-daemon-install')).toBeTruthy();
        expect(screen.findByTestId('web-desktop-handoff-terminal-step-relay-install')).toBeTruthy();
        expect(screen.findByTestId('web-desktop-handoff-terminal-step-relay-status')).toBeTruthy();
    });
});


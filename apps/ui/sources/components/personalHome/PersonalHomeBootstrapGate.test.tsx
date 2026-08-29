import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { PersonalHomeBootstrapGate } from './bootstrap/PersonalHomeBootstrapGate';
import type { PersonalHomeFacts } from './bootstrap/personalHomeBootstrapTypes';

const facts: PersonalHomeFacts = {
    hostIsDesktop: true,
    isDesktopMainWindow: true,
    completedPersonalHomeProfile: null,
    candidateLocalProfile: null,
    relayRuntime: null,
    localHomeReachability: 'unknown',
    localHomeIdentity: null,
    localHomeAuth: 'unknown',
    anonymousSignup: 'unknown',
    daemon: null,
    activeTask: null,
};

describe('PersonalHomeBootstrapGate', () => {
    it('keeps non-desktop hosts on the normal shell', async () => {
        const screen = await renderScreen(
            <PersonalHomeBootstrapGate isDesktopHost={false} readFacts={async () => facts}>
                <View testID="normal-shell" />
            </PersonalHomeBootstrapGate>,
        );
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-surface')).toBeNull();
    });

    it('gates only the desktop main window while facts are incomplete', async () => {
        const screen = await renderScreen(
            <PersonalHomeBootstrapGate isDesktopHost isDesktopMainWindow readFacts={async () => facts}>
                <View testID="normal-shell" />
            </PersonalHomeBootstrapGate>,
        );
        expect(screen.findByTestId('personal-home-setup-surface')).not.toBeNull();
        expect(screen.findByTestId('normal-shell')).toBeNull();
    });

    it('bypasses setup in an overlay window', async () => {
        const screen = await renderScreen(
            <PersonalHomeBootstrapGate isDesktopHost isDesktopMainWindow={false} readFacts={async () => facts}>
                <View testID="normal-shell" />
            </PersonalHomeBootstrapGate>,
        );
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
    });
});

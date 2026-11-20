import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';

import { WorkflowPanel } from '../unauthShell/WorkflowPanel';
import { WelcomeDecisionPanel } from './WelcomeDecisionPanel';

vi.mock('../unauthShell/WelcomeFooterLinks', () => ({
    WelcomeFooterLinks: 'WelcomeFooterLinks',
}));

const baseOptions: AuthEntryOptions = {
    serverAvailability: 'ready',
    authEntryUnavailable: false,
    serverUrlForCopy: 'https://relay.example.test',
    showAuthActions: true,
    retryServerCheck: () => {},
};

function renderPanel(variant: 'desktop' | 'mobile') {
    return renderScreen(
        <WorkflowPanel
            variant={variant}
            isWelcomeStep
            transitionKey="welcome"
            transitionDirection="replace"
        >
            <WelcomeDecisionPanel
                authEntryOptions={baseOptions}
                onOpenRestore={vi.fn()}
                onChangeRelay={vi.fn()} onConnectHomeDirectly={vi.fn()}
            />
        </WorkflowPanel>,
    );
}

describe('WelcomeDecisionPanel mobile wordmark', () => {
    beforeEach(() => {
        standardCleanup();
    });

    it('renders the Happier wordmark when the mobile workflow has no brand pane', async () => {
        const screen = await renderPanel('mobile');

        expect(screen.findByTestId('welcome-mobile-wordmark')).toBeTruthy();
        expect(screen.findByTestId('brand-wordmark')).toBeTruthy();
    });

    it('stands the one wordmark in the top-left corner of every computer step (direction A)', async () => {
        const screen = await renderPanel('desktop');

        expect(screen.findAllByTestId('welcome-mobile-wordmark')).toHaveLength(1);
    });
});

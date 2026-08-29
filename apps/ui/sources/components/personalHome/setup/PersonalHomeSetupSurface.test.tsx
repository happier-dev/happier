import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { PersonalHomeSetupSurface } from './PersonalHomeSetupSurface';
import type { PersonalHomeBootstrapSnapshot } from '../bootstrap/personalHomeBootstrapTypes';

const snapshot: PersonalHomeBootstrapSnapshot = {
    shouldGateShell: true,
    homeReady: false,
    daemonReady: false,
    phase: 'preparing-home',
    daemonState: 'not-started',
    rows: [
        { id: 'home', status: 'active' },
        { id: 'app', status: 'pending' },
        { id: 'computer', status: 'pending' },
    ],
    action: 'none',
};

describe('PersonalHomeSetupSurface', () => {
    it('renders one stable operational frame with three semantic rows', async () => {
        const screen = await renderScreen(<PersonalHomeSetupSurface snapshot={snapshot} />);
        expect(screen.findByTestId('personal-home-setup-surface')).not.toBeNull();
        expect(screen.findByTestId('personal-home-bootstrap-row-home')).not.toBeNull();
        expect(screen.findByTestId('personal-home-bootstrap-row-app')).not.toBeNull();
        expect(screen.findByTestId('personal-home-bootstrap-row-computer')).not.toBeNull();
        expect(screen.findByTestId('personal-home-bootstrap-phase')).not.toBeNull();
    });

    it('preserves completed rows and exposes retry/details for failure', async () => {
        const failed: PersonalHomeBootstrapSnapshot = {
            ...snapshot,
            phase: 'blocked',
            action: 'retry',
            rows: [
                { id: 'home', status: 'complete' },
                { id: 'app', status: 'blocked' },
                { id: 'computer', status: 'pending' },
            ],
            detail: { code: 'auth', message: 'Needs attention', retryable: true },
        };
        const screen = await renderScreen(
            <PersonalHomeSetupSurface snapshot={failed} onRetry={() => {}} onOpenDetails={() => {}} />,
        );
        expect(screen.findByTestId('personal-home-bootstrap-retry')).not.toBeNull();
        expect(screen.findByTestId('personal-home-bootstrap-details')).not.toBeNull();
        expect(screen.findByTestId('personal-home-bootstrap-row-home')).not.toBeNull();
    });
});

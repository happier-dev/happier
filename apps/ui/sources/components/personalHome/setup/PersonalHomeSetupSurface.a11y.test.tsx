import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { PersonalHomeSetupSurface } from './PersonalHomeSetupSurface';

describe('PersonalHomeSetupSurface accessibility', () => {
    it('announces phase changes politely and exposes retry/details as keyboard buttons', async () => {
        const screen = await renderScreen(
            <PersonalHomeSetupSurface
                snapshot={{
                    shouldGateShell: true,
                    homeReady: false,
                    daemonReady: false,
                    phase: 'blocked',
                    daemonState: 'not-started',
                    rows: [
                        { id: 'home', status: 'complete' },
                        { id: 'app', status: 'blocked' },
                        { id: 'computer', status: 'pending' },
                    ],
                    action: 'retry',
                    detail: { message: 'Needs attention', retryable: true },
                }}
                onRetry={() => {}}
                onOpenDetails={() => {}}
            />,
        );
        const phase = screen.findByTestId('personal-home-bootstrap-phase');
        expect(phase).not.toBeNull();
        expect(screen.findByTestId('personal-home-bootstrap-retry')?.props.accessibilityRole).toBe('button');
        expect(screen.findByTestId('personal-home-bootstrap-details')?.props.accessibilityRole).toBe('button');
        expect(screen.findByTestId('personal-home-bootstrap-failure')?.props.accessibilityRole).toBe('alert');
    });
});

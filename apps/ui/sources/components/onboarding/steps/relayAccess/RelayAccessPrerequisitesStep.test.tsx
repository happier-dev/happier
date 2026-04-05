import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('./RelayAccessLanUrlStep', () => ({
    RelayAccessLanUrlStep: (props: Record<string, unknown>) => React.createElement('RelayAccessLanUrlStep', props),
}));

vi.mock('./RelayAccessCloudflareNamedTunnelStep', () => ({
    RelayAccessCloudflareNamedTunnelStep: (props: Record<string, unknown>) => React.createElement('RelayAccessCloudflareNamedTunnelStep', props),
}));

describe('RelayAccessPrerequisitesStep', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('forwards LAN relay access requests to the LAN step', async () => {
        const { RelayAccessPrerequisitesStep } = await import('./RelayAccessPrerequisitesStep');
        const screen = await renderScreen(React.createElement(RelayAccessPrerequisitesStep, {
            providerId: 'lan',
            upstreamUrl: 'https://relay.example.test',
            serverProfileId: 'profile-1',
            target: { kind: 'local' },
        }));

        const step = screen.findByType('RelayAccessLanUrlStep' as never) as unknown as {
            props: {
                providerId?: string;
                upstreamUrl?: string;
                serverProfileId?: string;
                target?: { kind: 'local' };
            };
        };

        expect(step.props.upstreamUrl).toBe('https://relay.example.test');
        expect(step.props.serverProfileId).toBe('profile-1');
        expect(step.props.target).toEqual({ kind: 'local' });
    });

    it('forwards Cloudflare relay access requests to the Cloudflare step', async () => {
        const { RelayAccessPrerequisitesStep } = await import('./RelayAccessPrerequisitesStep');
        const screen = await renderScreen(React.createElement(RelayAccessPrerequisitesStep, {
            providerId: 'cloudflareNamed',
            upstreamUrl: 'https://relay.example.test',
            serverProfileId: 'profile-1',
            target: { kind: 'local' },
        }));

        const step = screen.findByType('RelayAccessCloudflareNamedTunnelStep' as never) as unknown as {
            props: {
                providerId?: string;
                upstreamUrl?: string;
                serverProfileId?: string;
                target?: { kind: 'local' };
            };
        };

        expect(step.props.upstreamUrl).toBe('https://relay.example.test');
        expect(step.props.serverProfileId).toBe('profile-1');
        expect(step.props.target).toEqual({ kind: 'local' });
    });
});

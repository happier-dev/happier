import { describe, expect, it } from 'vitest';

import { renderDaemonOwnerConflict } from './renderDaemonOwnerConflict';

describe('renderDaemonOwnerConflict', () => {
    const legacyOwner = {
        status: 'running' as const,
        source: 'state' as const,
        state: {
            pid: 123,
            httpPort: 43110,
            startedAt: Date.now(),
            startedWithCliVersion: '1.2.3',
            startedWithPublicReleaseChannel: 'preview' as const,
        },
        currentCliVersion: '9.9.9',
        currentPublicReleaseChannel: 'stable' as const,
        versionMatches: false,
        releaseChannelMatches: false,
        serviceManaged: null,
        startupSource: 'unknown' as const,
    };

    const serviceOwner = {
        ...legacyOwner,
        serviceManaged: true as const,
        startupSource: 'background-service' as const,
        state: {
            ...legacyOwner.state,
            serviceLabel: 'com.happier.cli.daemon.default',
        },
    };

    it('keeps daemon stop guidance neutral when the current owner source is unknown', () => {
        const rendered = renderDaemonOwnerConflict({
            intent: 'daemon-stop',
            owner: legacyOwner,
        });

        expect(rendered.title).toContain('could not be determined safely');
        expect(rendered.lines.join(' ')).toContain('Use `happier service stop` only if you know');
    });

    it('keeps daemon start guidance neutral when the current owner source is unknown', () => {
        const rendered = renderDaemonOwnerConflict({
            intent: 'daemon-start',
            owner: legacyOwner,
        });

        expect(rendered.title).toContain('relay owner');
        expect(rendered.title).not.toContain('relay runtime');
        expect(rendered.lines.join(' ')).toContain('Stop the current relay owner');
    });

    it('suggests takeover for daemon restart when a manual relay runtime already owns the relay', () => {
        const rendered = renderDaemonOwnerConflict({
            intent: 'daemon-restart',
            owner: {
                ...legacyOwner,
                serviceManaged: false as const,
                startupSource: 'manual' as const,
            },
        });

        expect(rendered.title).toContain('relay runtime');
        expect(rendered.lines.join(' ')).toContain('daemon restart --takeover');
        expect(rendered.lines.join(' ')).not.toContain('service restart');
    });

    it('tells daemon restart callers to use background service restart for a service-managed owner', () => {
        const rendered = renderDaemonOwnerConflict({
            intent: 'daemon-restart',
            owner: serviceOwner,
        });

        expect(rendered.title).toContain('background service');
        expect(rendered.lines.join(' ')).toContain('Use `happier service restart`');
        expect(rendered.lines.join(' ')).not.toContain('Use `happier service stop`');
    });
});

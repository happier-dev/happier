import { describe, expect, it } from 'vitest';
import type { DoctorSnapshotHomeTransportDiagnostics } from '@happier-dev/protocol/diagnostics/doctorSnapshot';

import { projectIrohHomeTransportPresentation } from './projectIrohHomeTransportPresentation';

describe('projectIrohHomeTransportPresentation', () => {
    it('demotes retained Iroh observations to historical last-known details when HTTPS is effective', () => {
        const diagnostics: DoctorSnapshotHomeTransportDiagnostics = {
            homeServerIdentityId: 'home-a',
            state: 'unavailable',
            current: { carrier: 'iroh', observedPath: 'direct' },
            lastKnown: { carrier: 'iroh', observedPath: 'relay' },
        };

        expect(projectIrohHomeTransportPresentation({
            effectiveCarrier: 'https',
            diagnostics,
        })).toMatchObject({
            heading: 'history',
            isHistorical: true,
            isEffectiveIroh: false,
            permitsRetry: false,
            transportState: null,
            primaryPath: {
                role: 'last_known',
                observation: { carrier: 'iroh', observedPath: 'relay' },
            },
            detailPaths: [{
                role: 'last_known',
                observation: { carrier: 'iroh', observedPath: 'relay' },
            }],
        });
    });

    it('keeps the live current path, state, and retry eligibility when Iroh is effective', () => {
        const diagnostics: DoctorSnapshotHomeTransportDiagnostics = {
            homeServerIdentityId: 'home-a',
            state: 'connected',
            current: { carrier: 'iroh', observedPath: 'direct' },
            lastKnown: { carrier: 'iroh', observedPath: 'relay' },
        };

        expect(projectIrohHomeTransportPresentation({
            effectiveCarrier: 'iroh',
            diagnostics,
        })).toMatchObject({
            heading: 'current',
            isHistorical: false,
            isEffectiveIroh: true,
            permitsRetry: true,
            transportState: 'connected',
            primaryPath: {
                role: 'current',
                observation: { carrier: 'iroh', observedPath: 'direct' },
            },
            detailPaths: [
                {
                    role: 'current',
                    observation: { carrier: 'iroh', observedPath: 'direct' },
                },
                {
                    role: 'last_known',
                    observation: { carrier: 'iroh', observedPath: 'relay' },
                },
            ],
        });
    });

    it.each([
        ['connected', { labelKey: 'status.connected', statusKey: 'connected' }],
        ['connecting', { labelKey: 'status.connecting', statusKey: 'connecting' }],
        ['reconnecting', { labelKey: 'connectionStatus.summary.reconnecting', statusKey: 'connecting' }],
        ['unavailable', { labelKey: 'connectionStatus.summary.unavailable', statusKey: 'error' }],
        ['disconnected', { labelKey: 'status.disconnected', statusKey: 'disconnected' }],
    ] as const)('labels a live %s Iroh transport with the Home summary vocabulary', (state, transportStatus) => {
        expect(projectIrohHomeTransportPresentation({
            effectiveCarrier: 'iroh',
            diagnostics: {
                homeServerIdentityId: 'home-a',
                state,
                current: { carrier: 'iroh', observedPath: 'direct' },
            },
        }).transportStatus).toEqual(transportStatus);
    });

    it('never labels retained facts under HTTPS as a live transport state', () => {
        expect(projectIrohHomeTransportPresentation({
            effectiveCarrier: 'https',
            diagnostics: {
                homeServerIdentityId: 'home-a',
                state: 'connected',
                current: { carrier: 'iroh', observedPath: 'direct' },
            },
        }).transportStatus).toEqual({ labelKey: 'status.unknown', statusKey: 'unknown' });
        // No diagnostics at all: nothing to label; the endpoint status decides.
        expect(projectIrohHomeTransportPresentation({ effectiveCarrier: 'iroh', diagnostics: null }).transportStatus).toBeNull();
    });
});

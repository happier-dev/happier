import { describe, expect, it } from 'vitest';

import type { CurrentDaemonOwner, DaemonOwnerEvaluation } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { resolveDaemonTakeoverDecision } from './resolveDaemonTakeoverDecision';

function buildOwner(overrides: Partial<CurrentDaemonOwner> = {}): CurrentDaemonOwner {
    return {
        status: 'running',
        state: {
            pid: 1,
            httpPort: 43111,
            startedAt: 1,
            startedWithCliVersion: '0.0.0-test',
            startedWithPublicReleaseChannel: 'preview',
            startupSource: 'background-service',
            serviceLabel: 'happier-daemon.preview',
        },
        currentCliVersion: '0.0.0-current',
        currentPublicReleaseChannel: 'preview',
        versionMatches: true,
        releaseChannelMatches: true,
        serviceManaged: true,
        startupSource: 'background-service',
        ...overrides,
    };
}

function buildEvaluation(kind: DaemonOwnerEvaluation['kind'], owner?: CurrentDaemonOwner): DaemonOwnerEvaluation {
    if (kind === 'none') {
        return { kind: 'none' };
    }
    if (!owner) {
        throw new Error('owner is required for non-none evaluations');
    }
    return { kind, owner };
}

describe('resolveDaemonTakeoverDecision', () => {
    it('allows startup when no daemon is running', () => {
        expect(resolveDaemonTakeoverDecision({
            ownership: buildEvaluation('none'),
            takeoverRequested: false,
            startupSource: 'manual',
        })).toEqual({ kind: 'ok' });
    });

    it('allows startup when the current owner is already compatible', () => {
        expect(resolveDaemonTakeoverDecision({
            ownership: buildEvaluation('compatible', buildOwner()),
            takeoverRequested: true,
            startupSource: 'manual',
        })).toEqual({ kind: 'ok' });
    });

    it('returns a manual-owner takeover when takeover is requested for a manual relay runtime', () => {
        expect(resolveDaemonTakeoverDecision({
            ownership: buildEvaluation('conflict', buildOwner({
                serviceManaged: false,
                startupSource: 'manual',
            })),
            takeoverRequested: true,
            startupSource: 'manual',
        })).toEqual({
            kind: 'manual-owner-takeover',
            owner: buildOwner({
                serviceManaged: false,
                startupSource: 'manual',
            }),
        });
    });

    it('allows replacing a stale manual relay runtime without an explicit takeover flag', () => {
        expect(resolveDaemonTakeoverDecision({
            ownership: buildEvaluation('conflict', buildOwner({
                serviceManaged: false,
                startupSource: 'manual',
                versionMatches: false,
            })),
            takeoverRequested: false,
            startupSource: 'manual',
        })).toEqual({
            kind: 'manual-owner-replace',
            owner: buildOwner({
                serviceManaged: false,
                startupSource: 'manual',
                versionMatches: false,
            }),
        });
    });

    it('keeps service-managed conflicts closed even when takeover is requested', () => {
        expect(resolveDaemonTakeoverDecision({
            ownership: buildEvaluation('conflict', buildOwner({
                serviceManaged: true,
                startupSource: 'background-service',
            })),
            takeoverRequested: true,
            startupSource: 'background-service',
        })).toEqual({
            kind: 'conflict',
            owner: buildOwner({
                serviceManaged: true,
                startupSource: 'background-service',
            }),
        });
    });

    it('keeps manual owner conflicts closed for background-service startup without explicit takeover', () => {
        expect(resolveDaemonTakeoverDecision({
            ownership: buildEvaluation('conflict', buildOwner({
                serviceManaged: false,
                startupSource: 'manual',
                versionMatches: false,
            })),
            takeoverRequested: false,
            startupSource: 'background-service',
        })).toEqual({
            kind: 'conflict',
            owner: buildOwner({
                serviceManaged: false,
                startupSource: 'manual',
                versionMatches: false,
            }),
        });
    });
});

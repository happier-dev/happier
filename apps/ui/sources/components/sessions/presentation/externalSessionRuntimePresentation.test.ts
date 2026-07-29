import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';
import {
    readExternalAgentObservationPresentationInput,
    resolveExternalSessionCandidateActivityPresentation,
    resolveExternalSessionRuntimePresentation,
} from './externalSessionRuntimePresentation';

const canonicalObservation = {
    v: 1,
    qualifiedLinkIdentity: {
        v: 1,
        agent: {
            pluginId: 'happier.opencode',
            localId: 'opencode',
        },
        source: {
            kind: 'opencode.server',
            contractVersion: 1,
        },
    },
    linkGeneration: 'link-generation-1',
    status: 'working',
    observedAtMs: 1_000,
    expiresAtMs: 2_000,
} as const;

describe('resolveExternalSessionRuntimePresentation', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('maps browse candidate activity through the shared external-session presenter', () => {
        expect(resolveExternalSessionCandidateActivityPresentation('running')).toMatchObject({
            state: 'working',
            labelKey: 'status.workingExternally',
            tone: 'live',
            indicator: 'working',
        });
        expect(resolveExternalSessionCandidateActivityPresentation('idle')).toMatchObject({
            state: 'idle',
            labelKey: 'status.ready',
            tone: 'ready',
        });
    });

    it.each([
        ['working', 'status.workingExternally', 'live', 'working'],
        ['waiting', 'status.needsInputExternally', 'attention', 'action'],
        ['retrying', 'status.retryingExternally', 'warning', 'action'],
        ['idle', 'status.ready', 'ready', 'ready'],
        ['recentlyActive', 'status.recentlyActive', 'muted', 'none'],
        ['unknown', 'status.externalStatusUnknown', 'muted', 'none'],
    ] as const)('maps %s without conflating connectivity or detached activity', (state, labelKey, tone, indicator) => {
        expect(resolveExternalSessionRuntimePresentation({
            controlConnectivity: 'offline',
            detachedActivity: 'active',
            externalAgent: { state, observedAtMs: 1_000, expiresAtMs: 2_000 },
            nowMs: 1_500,
        })).toEqual({
            controlConnectivity: 'offline',
            detachedActivity: 'active',
            externalAgent: {
                state,
                labelKey,
                tone,
                indicator,
                nextExpiryAtMs: state === 'unknown' ? null : 2_000,
            },
        });
    });

    it('keeps working externally visible while control is offline', () => {
        const presentation = resolveExternalSessionRuntimePresentation({
            controlConnectivity: 'offline',
            detachedActivity: 'idle',
            externalAgent: { state: 'working', observedAtMs: 1_000, expiresAtMs: 2_000 },
            nowMs: 1_500,
        });

        expect(presentation.controlConnectivity).toBe('offline');
        expect(presentation.detachedActivity).toBe('idle');
        expect(presentation.externalAgent).toMatchObject({
            state: 'working',
            labelKey: 'status.workingExternally',
            indicator: 'working',
        });
        expect(presentation).not.toHaveProperty('composerEnabled');
        expect(presentation).not.toHaveProperty('pending');
    });

    it('reads presentation status only from the canonical pushed runtime.externalAgent snapshot', () => {
        expect(readExternalAgentObservationPresentationInput({
            externalAgentObservationV1: canonicalObservation,
            externalProvider: {
                status: 'waiting',
                observedAtMs: 1_100,
                expiresAtMs: 3_000,
            },
            active: true,
            thinking: true,
            pendingQueueV1: { count: 2 },
        })).toEqual({
            state: 'working',
            observedAtMs: 1_000,
            expiresAtMs: 2_000,
        });

        expect(readExternalAgentObservationPresentationInput({
            externalProvider: canonicalObservation,
            active: true,
            thinking: true,
        })).toEqual({
            state: 'unknown',
            observedAtMs: 0,
            expiresAtMs: null,
        });
    });

    it('fails stale or unbounded observations closed to honest unknown', () => {
        for (const expiresAtMs of [null, Number.NaN, 1_000]) {
            expect(resolveExternalSessionRuntimePresentation({
                controlConnectivity: 'offline',
                detachedActivity: 'unknown',
                externalAgent: { state: 'working', observedAtMs: 900, expiresAtMs },
                nowMs: 1_000,
            }).externalAgent).toEqual({
                state: 'unknown',
                labelKey: 'status.externalStatusUnknown',
                tone: 'muted',
                indicator: 'none',
                nextExpiryAtMs: null,
            });
        }
    });

    it('expires through the one shared session-list clock without a row timer', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const clock = createSessionListRuntimeClock();
        const token = {};
        const listener = vi.fn();
        const unsubscribe = clock.subscribe(listener);
        const observation = { state: 'working' as const, observedAtMs: 900, expiresAtMs: 1_100 };
        const initial = resolveExternalSessionRuntimePresentation({
            controlConnectivity: 'offline',
            detachedActivity: 'idle',
            externalAgent: observation,
            nowMs: clock.getNowMs(),
        });

        clock.requestWake(token, initial.externalAgent.nextExpiryAtMs!);
        expect(vi.getTimerCount()).toBe(1);

        vi.advanceTimersByTime(101);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(resolveExternalSessionRuntimePresentation({
            controlConnectivity: 'offline',
            detachedActivity: 'idle',
            externalAgent: observation,
            nowMs: clock.getNowMs(),
        }).externalAgent).toEqual({
            state: 'unknown',
            labelKey: 'status.externalStatusUnknown',
            tone: 'muted',
            indicator: 'none',
            nextExpiryAtMs: null,
        });
        expect(vi.getTimerCount()).toBe(0);

        unsubscribe();
    });
});

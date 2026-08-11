import { describe, expect, it } from 'vitest';

import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import type { Session } from '@/sync/domains/state/storageTypes';

import { deriveSessionWorkObservation, type SessionWorkObservation } from './deriveSessionWorkObservation';

/**
 * The consuming surface holds a whole `Session`, so the resolver has to accept one as-is — a lane
 * boundary this build must not be able to break silently.
 */
const acceptsASession: (session: Session, nowMs: number) => SessionWorkObservation = deriveSessionWorkObservation;
void acceptsASession;

const nowMs = 10_000_000;

function issue(over: Partial<SessionRuntimeIssueV1> = {}): SessionRuntimeIssueV1 {
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'provider_auth_expired',
        source: 'auth_error',
        occurredAt: nowMs - 3_600_000,
        ...over,
    } as SessionRuntimeIssueV1;
}

describe('deriveSessionWorkObservation', () => {
    it('reports the session-level stop the CLI already classified, with the instant it happened', () => {
        // The photographed case: the provider's query died of an expired sign-in, so the agents it
        // owned are gone — while the roster still paints them running. The session fact is knowable
        // and datable; the per-row statuses are not.
        expect(deriveSessionWorkObservation({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            lastRuntimeIssue: issue(),
        }, nowMs)).toEqual({
            state: 'stopped',
            sinceMs: nowMs - 3_600_000,
            reason: 'auth',
        });
    });

    it('keeps a usage-limit stop distinguishable from every other stop', () => {
        // Usage limits already have a surface owner with its own copy, reset time and recovery
        // action. Classifying it rather than folding it into a generic stop is what lets a consumer
        // hand it back to that owner instead of growing a second usage-limit voice.
        expect(deriveSessionWorkObservation({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            lastRuntimeIssue: issue({ source: 'usage_limit', code: 'usage_limit_reached' }),
        }, nowMs)).toMatchObject({ state: 'stopped', reason: 'usage_limit' });
    });

    it('classifies a provider process exit apart from an in-session error', () => {
        expect(deriveSessionWorkObservation({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            lastRuntimeIssue: issue({ source: 'provider_process_exit' }),
        }, nowMs)).toMatchObject({ state: 'stopped', reason: 'process_exit' });

        expect(deriveSessionWorkObservation({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            lastRuntimeIssue: issue({ source: 'stream_error' }),
        }, nowMs)).toMatchObject({ state: 'stopped', reason: 'error' });
    });

    it('stops reporting a stop once the session has been observed working since', () => {
        expect(deriveSessionWorkObservation({
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            lastRuntimeIssue: issue(),
            meaningfulActivityAt: nowMs - 60_000,
        }, nowMs)).toEqual({ state: 'observed' });
    });

    it('says the session is no longer observed, and since when, once its runtime is gone', () => {
        expect(deriveSessionWorkObservation({
            active: false,
            activeAt: nowMs - 900_000,
            presence: 'offline',
            runtimeActivityObservedAt: nowMs - 1_800_000,
        }, nowMs)).toEqual({
            state: 'unobserved',
            sinceMs: nowMs - 900_000,
        });
    });

    it('says the session is no longer observed when every witness of it has aged out', () => {
        expect(deriveSessionWorkObservation({
            active: true,
            activeAt: nowMs - 600_000,
            presence: 'online',
            runtimeActivityObservedAt: nowMs - 600_000,
        }, nowMs)).toMatchObject({ state: 'unobserved', sinceMs: nowMs - 600_000 });
    });

    it('says nothing at all about a session that is still being observed', () => {
        expect(deriveSessionWorkObservation({
            active: true,
            activeAt: nowMs - 15_000,
            presence: 'online',
            runtimeActivityObservedAt: nowMs - 3_600_000,
        }, nowMs)).toEqual({ state: 'observed' });
    });

    it('never invents an instant it was never given', () => {
        expect(deriveSessionWorkObservation({}, nowMs)).toEqual({
            state: 'unobserved',
            sinceMs: null,
        });
    });
});

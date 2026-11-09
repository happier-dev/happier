import { describe, expect, it } from 'vitest';
import type { SessionPublicLinkSettingsV1 } from '@happier-dev/protocol/sessions/access/sessionAccessActionsV1';

import {
    mergeSessionPublicLinkWithCachedBearer,
    type SessionPublicLinkPublication,
} from './sessionPublicLinkPublication';

function settings(overrides: Partial<SessionPublicLinkSettingsV1> = {}): SessionPublicLinkSettingsV1 {
    return {
        id: 'publication-1',
        expiresAt: null,
        maxUses: null,
        useCount: 0,
        isConsentRequired: false,
        updatedAt: 1,
        ...overrides,
    };
}

function publication(overrides: Partial<SessionPublicLinkPublication> = {}): SessionPublicLinkPublication {
    return { ...settings(), token: 'cached', ...overrides };
}

describe('session public-link cached bearer', () => {
    it('keeps the last known publication when the read failed', () => {
        const previous = publication();
        expect(mergeSessionPublicLinkWithCachedBearer({
            previousPublication: previous,
            cachedToken: 'cached',
            outcome: { ok: false },
        })).toEqual({ publication: previous, cachedToken: 'cached' });
    });

    it('retains the device-held bearer across a byte-identical settings refresh', () => {
        const previous = publication({ id: 'publication-current', publicUrl: 'https://public.example/s/lookup#k=secret' });
        const refreshed = settings({ id: 'publication-current' });
        expect(mergeSessionPublicLinkWithCachedBearer({
            previousPublication: previous,
            cachedToken: 'cached',
            outcome: { ok: true, publication: refreshed },
        })).toEqual({
            publication: { ...refreshed, token: 'cached', publicUrl: previous.publicUrl },
            cachedToken: 'cached',
        });
    });

    it('clears the device-held bearer after public consumption changes the settings snapshot', () => {
        const previous = publication({ id: 'publication-current' });
        // Only the consumption counter moves, so the bearer is cleared by that
        // comparison alone (updatedAt is proven by the rotation case below).
        const refreshed = settings({ id: 'publication-current', useCount: 1 });
        expect(mergeSessionPublicLinkWithCachedBearer({
            previousPublication: previous,
            cachedToken: 'cached',
            outcome: { ok: true, publication: refreshed },
        })).toEqual({
            publication: { ...refreshed, token: null },
            cachedToken: null,
        });
    });

    it('clears an old bearer when another device rotated the publication', () => {
        const previous = publication({ id: 'publication-current' });
        // Rotation keeps the row id, so neither id nor updatedAt can re-prove
        // this device's bearer after a successful settings read.
        const remote = settings({ id: 'publication-current', updatedAt: 2 });

        expect(mergeSessionPublicLinkWithCachedBearer({
            previousPublication: previous,
            cachedToken: 'cached',
            outcome: { ok: true, publication: remote },
        })).toEqual({ publication: { ...remote, token: null }, cachedToken: null });
    });

    it('does not attach a cached bearer when the publication token identity is unproven', () => {
        expect(mergeSessionPublicLinkWithCachedBearer({
            previousPublication: null,
            cachedToken: 'cached',
            outcome: { ok: true, publication: settings() },
        })).toEqual({ publication: { ...settings(), token: null }, cachedToken: null });
    });

    it('clears the bearer when the publication is authoritatively absent', () => {
        expect(mergeSessionPublicLinkWithCachedBearer({
            previousPublication: publication(),
            cachedToken: 'cached',
            outcome: { ok: true, publication: null },
        })).toEqual({ publication: null, cachedToken: null });
    });
});

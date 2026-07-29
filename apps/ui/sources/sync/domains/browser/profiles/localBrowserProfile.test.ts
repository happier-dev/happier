import { BrowserProfileV1Schema, type BrowserProfileV1, type FeatureDecision } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { evaluateBrowserTargetPolicy } from '../policy/evaluate';
import {
    LOCAL_BROWSER_PROFILE,
    LOCAL_BROWSER_PROFILE_ID,
    resolveLocalBrowserProfile,
} from './localBrowserProfile';

const enabledBrowserDecision = {
    featureId: 'browser',
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 1,
    scope: { scopeKind: 'runtime' },
} satisfies FeatureDecision;

describe('localBrowserProfile', () => {
    it('is a schema-valid, active, non-plugin user profile', () => {
        const parsed = BrowserProfileV1Schema.safeParse(LOCAL_BROWSER_PROFILE);
        expect(parsed.success).toBe(true);
        expect(LOCAL_BROWSER_PROFILE.profileId).toBe(LOCAL_BROWSER_PROFILE_ID);
        expect(LOCAL_BROWSER_PROFILE.storageMode).toBe('user');
        expect(LOCAL_BROWSER_PROFILE.owner.kind).toBe('user');
        expect(LOCAL_BROWSER_PROFILE.lifecycleState).toBe('active');
    });

    it('prefers an explicit profile and falls back to the host-local default for null/undefined', () => {
        const explicit = {
            profileId: 'profile_session_1',
            storageMode: 'session',
            owner: { kind: 'session', id: 'session_1' },
            cleanupOnSessionClose: true,
        } satisfies BrowserProfileV1;

        expect(resolveLocalBrowserProfile(explicit)).toBe(explicit);
        expect(resolveLocalBrowserProfile(null)).toBe(LOCAL_BROWSER_PROFILE);
        expect(resolveLocalBrowserProfile(undefined)).toBe(LOCAL_BROWSER_PROFILE);
        // Stable singleton so memoized seed/selection inputs stay referentially stable.
        expect(resolveLocalBrowserProfile(null)).toBe(resolveLocalBrowserProfile(undefined));
    });

    it('lets an allowed external-URL policy resolve with the default profile (no profile_missing)', () => {
        const decision = evaluateBrowserTargetPolicy({
            target: {
                kind: 'externalUrl',
                targetId: 'external_1',
                url: 'https://example.com/',
                display: { title: 'Example', addressLabel: 'example.com' },
            },
            profile: resolveLocalBrowserProfile(null),
            browserFeatureDecision: enabledBrowserDecision,
            allowExternalUrlBrowsing: true,
        });

        expect(decision.state).toBe('allowed');
        expect(decision.profileId).toBe(LOCAL_BROWSER_PROFILE_ID);
    });
});

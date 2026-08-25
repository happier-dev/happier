import { MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import type { PosthogConfiguredEnvironment } from '../source/instance.js';
import { preflightPosthogEnvironmentSelection } from './configuration.js';

const POLICY = { kind: 'relative', durationMs: 86_400_000 } as const;
const ORGANIZATION = '00000000-0000-4000-8000-0000000000a1';

function environment(displayName: string): PosthogConfiguredEnvironment {
    return {
        teamPathId: 1,
        teamUuid: '00000000-0000-4000-8000-0000000000d1',
        displayName,
    };
}

function atBytes(bytes: number): PosthogConfiguredEnvironment {
    const base = preflightPosthogEnvironmentSelection([], [environment('🙂')], {
        organizationUuid: ORGANIZATION,
        scanWindowPolicy: POLICY,
        detailWindowPolicy: POLICY,
    });
    if (base.encoding.utf8Bytes === undefined) throw new Error('fixture must be measurable');
    return environment(`🙂${'x'.repeat(bytes - base.encoding.utf8Bytes)}`);
}

describe('PostHog environment selection preflight', () => {
    it('accepts the exact UTF-8 token ceiling, including a multi-byte display name', () => {
        const below = preflightPosthogEnvironmentSelection(
            [],
            [atBytes(MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 - 1)],
            {
                organizationUuid: ORGANIZATION,
                scanWindowPolicy: POLICY,
                detailWindowPolicy: POLICY,
            },
        );
        const proposed = [atBytes(MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1)];
        const result = preflightPosthogEnvironmentSelection([], proposed, {
            organizationUuid: ORGANIZATION,
            scanWindowPolicy: POLICY,
            detailWindowPolicy: POLICY,
        });

        expect(below).toMatchObject({
            accepted: true,
            encoding: { utf8Bytes: MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 - 1 },
        });
        expect(result.accepted).toBe(true);
        expect(result.encoding.utf8Bytes).toBe(MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1);
        expect(result.environments).toBe(proposed);
    });

    it('refuses one UTF-8 byte over the ceiling and preserves the prior selection', () => {
        const current = [environment('working')];
        const proposed = [atBytes(MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 + 1)];
        const result = preflightPosthogEnvironmentSelection(current, proposed, {
            organizationUuid: ORGANIZATION,
            scanWindowPolicy: POLICY,
            detailWindowPolicy: POLICY,
        });

        expect(result.accepted).toBe(false);
        expect(result.encoding).toMatchObject({
            ok: false,
            reason: 'tokenTooLarge',
            utf8Bytes: MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 + 1,
        });
        expect(result.environments).toBe(current);
    });
});

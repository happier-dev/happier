import { MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
    decodePosthogConfiguration,
    encodePosthogConfiguration,
    resolvePosthogWindowPolicy,
    type PosthogConfigurationToken,
} from './instance.js';

const CONFIGURATION: PosthogConfigurationToken = {
    v: 1,
    organizationUuid: '00000000-0000-4000-8000-0000000000a1',
    environments: [{
        teamPathId: 4821,
        teamUuid: '00000000-0000-4000-8000-0000000000d1',
        parentProjectId: 4820,
        displayName: 'Storefront production',
    }],
    scanWindowPolicy: { kind: 'relative', durationMs: 30 * 24 * 60 * 60 * 1_000 },
    detailWindowPolicy: { kind: 'relative', durationMs: 30 * 24 * 60 * 60 * 1_000 },
};

describe('PostHog configured-instance codec', () => {
    it('round-trips only source facts and never encodes account or origin authority', () => {
        const encoded = encodePosthogConfiguration(CONFIGURATION);

        expect(encoded.ok).toBe(true);
        if (!encoded.ok) return;
        expect(decodePosthogConfiguration({ v: 1, token: encoded.token })).toEqual(CONFIGURATION);
        expect(encoded.token).not.toContain('https://');
        expect(encoded.token).not.toContain('accountId');
    });

    it('rejects duplicate Team UUIDs and invalid or over-limit tokens', () => {
        expect(encodePosthogConfiguration({
            ...CONFIGURATION,
            environments: [CONFIGURATION.environments[0]!, CONFIGURATION.environments[0]!],
        }).ok).toBe(false);
        expect(decodePosthogConfiguration({
            v: 1,
            token: 'x'.repeat(MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 + 1),
        })).toBeNull();
        expect(decodePosthogConfiguration({ v: 1, token: '{"v":2}' })).toBeNull();
    });

    it('freezes a relative policy to one exact provider window', () => {
        expect(resolvePosthogWindowPolicy(
            { kind: 'relative', durationMs: 86_400_000 },
            Date.parse('2026-08-15T12:00:00.000Z'),
        )).toEqual({
            from: '2026-08-14T12:00:00.000Z',
            to: '2026-08-15T12:00:00.000Z',
        });
    });
});

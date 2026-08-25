import {
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
    MAX_POSTHOG_DIRECTORY_NEXT_URL_UTF8_BYTES_V1,
    MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1,
    PosthogConfigurationDirectoryResultV1Schema,
} from './configurationContract.js';

const encoder = new TextEncoder();
// Canonical transport owner: protocol/runtime/agentSessionLimitsV1.ts.
const ACTION_JSON_BYTES = 1_024 * 1_024;

function escapedBytes(bytes: number): string {
    return '\\'.repeat(bytes);
}

describe('PostHog configuration directory transport bounds', () => {
    it('keeps a maximal organization page inside the shared Action JSON boundary', () => {
        const nextPrefix = 'https://eu.posthog.com/';
        const result = {
            kind: 'organizations',
            rows: Array.from({ length: MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1 }, () => ({
                organizationUuid: '00000000-0000-4000-8000-0000000000a1',
                displayName: escapedBytes(MAX_TRIAGE_TEXT_UTF8_BYTES_V1),
                localInstanceKey: escapedBytes(MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1),
            })),
            next: `${nextPrefix}${'x'.repeat(
                MAX_POSTHOG_DIRECTORY_NEXT_URL_UTF8_BYTES_V1 - nextPrefix.length,
            )}`,
        };

        expect(() => PosthogConfigurationDirectoryResultV1Schema.parse(result)).not.toThrow();
        expect(encoder.encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
            ACTION_JSON_BYTES,
        );
        expect(encoder.encode(JSON.stringify({
            ...result,
            rows: [...result.rows, result.rows[0]],
        })).byteLength).toBeGreaterThan(ACTION_JSON_BYTES);
    });
});

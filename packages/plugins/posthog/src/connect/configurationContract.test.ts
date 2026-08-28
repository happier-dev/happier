import { describe, expect, it } from 'vitest';

import {
    MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1,
    PosthogConfigurationDirectoryResultV1Schema,
} from './configurationContract.js';

describe('PostHog configuration directory provider page bound', () => {
    it('uses the provider directory page size rather than a generic Action byte quota', () => {
        const row = {
            organizationUuid: '00000000-0000-4000-8000-0000000000a1',
            displayName: 'Organization',
            localInstanceKey: 'posthog-org:https://eu.posthog.com:00000000-0000-4000-8000-0000000000a1',
        };
        const result = {
            kind: 'organizations',
            rows: Array.from({ length: MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1 }, () => row),
        };

        expect(MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1).toBe(100);
        expect(() => PosthogConfigurationDirectoryResultV1Schema.parse(result)).not.toThrow();
        expect(() => PosthogConfigurationDirectoryResultV1Schema.parse({
            ...result,
            rows: [...result.rows, result.rows[0]],
        })).toThrow();
    });

    it('does not invent a source-local byte ceiling for a validated provider continuation', () => {
        const next = `https://eu.posthog.com/api/organizations/?cursor=${'a'.repeat(9 * 1024)}`;
        expect(() => PosthogConfigurationDirectoryResultV1Schema.parse({
            kind: 'organizations',
            rows: [],
            next,
        })).not.toThrow();
    });
});

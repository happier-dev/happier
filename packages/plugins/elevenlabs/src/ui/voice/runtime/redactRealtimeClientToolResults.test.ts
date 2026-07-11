import { describe, expect, it, vi } from 'vitest';

import {
    redactRealtimeClientToolResultString,
    redactRealtimeClientToolResults,
} from './redactRealtimeClientToolResults.js';
import type { VoiceToolResultRedactionPrefs } from './types.js';

const redactValue = (value: unknown, prefs: VoiceToolResultRedactionPrefs): unknown => {
    if (Array.isArray(value)) return value.map((entry) => redactValue(entry, prefs));
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (!prefs.shareSessionSummary && key === 'title') continue;
        if (!prefs.shareFilePaths && key === 'locationLabel') continue;
        if (!prefs.sharePermissionRequests && ['requestId', 'requestIds', 'permissionRequestIds'].includes(key)) continue;
        result[key] = redactValue(entry, prefs);
    }
    return result;
};

const SHARE_NOTHING: VoiceToolResultRedactionPrefs = {
    shareFilePaths: false,
    shareSessionSummary: false,
    sharePermissionRequests: false,
};

const SHARE_ALL: VoiceToolResultRedactionPrefs = {
    shareFilePaths: true,
    shareSessionSummary: true,
    sharePermissionRequests: true,
};

describe('redactRealtimeClientToolResultString', () => {
    it('strips session summary (title) and path (locationLabel) when sharing is disabled', () => {
        const raw = JSON.stringify({
            sessions: [{ id: 'sess_1', title: 'Secret summary', locationLabel: 'work/private-repo' }],
        });

        const redacted = JSON.parse(redactRealtimeClientToolResultString(raw, SHARE_NOTHING, redactValue));

        expect(redacted.sessions[0].id).toBe('sess_1');
        expect(redacted.sessions[0].title).toBeUndefined();
        expect(redacted.sessions[0].locationLabel).toBeUndefined();
    });

    it('preserves summary and path when sharing is enabled', () => {
        const raw = JSON.stringify({
            sessions: [{ id: 'sess_1', title: 'Visible summary', locationLabel: 'work/repo' }],
        });

        const redacted = JSON.parse(redactRealtimeClientToolResultString(raw, SHARE_ALL, redactValue));

        expect(redacted.sessions[0].title).toBe('Visible summary');
        expect(redacted.sessions[0].locationLabel).toBe('work/repo');
    });

    it('fails closed (drops the whole result) when the redacted value cannot be serialized', () => {
        // Exercise the actual serialization-failure boundary rather than merely
        // re-asserting ordinary key redaction. A malformed SDK handler is a system
        // boundary, so the wrapper must fail closed even when it violates the
        // declared string contract at runtime.
        const wrapped = redactRealtimeClientToolResults(
            { tool: async () => ({ value: 1n } as unknown as string) },
            () => SHARE_NOTHING,
            redactValue,
        );
        return expect(wrapped.tool(null)).resolves.toBe('{}');
    });

    it('removes permission aliases and deep payloads from the final realtime tool string', () => {
        let nested: Record<string, unknown> = {
            requestId: 'req_secret',
            requestIds: ['req_secret_2'],
            permissionRequestIds: ['req_secret_3'],
        };
        for (let depth = 0; depth < 24; depth += 1) nested = { nested };

        const result = redactRealtimeClientToolResultString(JSON.stringify(nested), SHARE_NOTHING, redactValue);

        expect(result).not.toContain('req_secret');
        expect(result).not.toContain('requestId');
    });
});

describe('redactRealtimeClientToolResults', () => {
    it('wraps every handler so realtime tool results are redacted before reaching the provider', async () => {
        const rawHandler = vi.fn(async () =>
            JSON.stringify({ sessions: [{ id: 's1', title: 'private', locationLabel: 'repo/path' }] }),
        );

        const wrapped = redactRealtimeClientToolResults(
            { getSessions: rawHandler },
            () => SHARE_NOTHING,
            redactValue,
        );

        const result = JSON.parse(await wrapped.getSessions({ limit: 1 }));

        expect(rawHandler).toHaveBeenCalledWith({ limit: 1 });
        expect(result.sessions[0].id).toBe('s1');
        expect(result.sessions[0].title).toBeUndefined();
        expect(result.sessions[0].locationLabel).toBeUndefined();
    });

    it('resolves prefs per invocation so a settings change between calls is honored', async () => {
        const rawHandler = vi.fn(async () => JSON.stringify({ title: 'x' }));
        let prefs: VoiceToolResultRedactionPrefs = SHARE_ALL;
        const wrapped = redactRealtimeClientToolResults({ tool: rawHandler }, () => prefs, redactValue);

        const first = JSON.parse(await wrapped.tool(null));
        expect(first.title).toBe('x');

        prefs = SHARE_NOTHING;
        const second = JSON.parse(await wrapped.tool(null));
        expect(second.title).toBeUndefined();
    });
});

import { describe, expect, test } from 'vitest';

import { getAgentVendorResumeId } from './resumeCapabilities';

describe('getAgentVendorResumeId', () => {
    test('returns null when metadata missing', () => {
        expect(getAgentVendorResumeId(null, 'claude')).toBeNull();
    });

    test('returns null when agent is not resumable', () => {
        expect(getAgentVendorResumeId({ claudeSessionId: 'c1' }, 'gemini')).toBeNull();
    });

    test('returns Claude session id when agent is claude', () => {
        expect(getAgentVendorResumeId({ claudeSessionId: 'c1' }, 'claude')).toBe('c1');
    });

    test('returns null for experimental resume agents when not enabled', () => {
        expect(getAgentVendorResumeId({ codexSessionId: 'x1' }, 'codex')).toBeNull();
    });

    test('returns Codex session id when experimental resume is enabled for Codex by settings', () => {
        expect(getAgentVendorResumeId(
            { codexSessionId: 'x1' },
            'codex',
            { accountSettings: { codexBackendMode: 'acp' } },
        )).toBe('x1');
    });

    test('treats persisted Codex flavor aliases as Codex for resume', () => {
        expect(getAgentVendorResumeId(
            { codexSessionId: 'x1' },
            'openai',
            { accountSettings: { codexBackendMode: 'acp' } },
        )).toBe('x1');
        expect(getAgentVendorResumeId(
            { codexSessionId: 'x1' },
            'gpt',
            { accountSettings: { codexBackendMode: 'acp' } },
        )).toBe('x1');
    });

    test('returns OpenCode session id when metadata contains it', () => {
        expect(getAgentVendorResumeId({ opencodeSessionId: 'o1' }, 'opencode')).toBe('o1');
    });

    test('treats empty ids as missing and trims non-empty strings', () => {
        expect(getAgentVendorResumeId({ claudeSessionId: '' }, 'claude')).toBeNull();
        expect(getAgentVendorResumeId({ claudeSessionId: ' c1 ' }, 'claude')).toBe('c1');
        expect(getAgentVendorResumeId(
            { codexSessionId: '   ' },
            'codex',
            { accountSettings: { codexBackendMode: 'acp' } },
        )).toBeNull();
        expect(getAgentVendorResumeId({ opencodeSessionId: '   ' }, 'opencode')).toBeNull();
    });

    test('returns null when metadata does not contain the canonical field for the resolved agent', () => {
        expect(getAgentVendorResumeId({ sessionId: 'x1' }, 'claude')).toBeNull();
        expect(getAgentVendorResumeId(
            { sessionId: 'x1' },
            'codex',
            { accountSettings: { codexBackendMode: 'acp' } },
        )).toBeNull();
    });

    test('supports persisted alias flavors for codex in table-driven form', () => {
        const aliases = ['codex', 'openai', 'gpt'] as const;
        for (const alias of aliases) {
            expect(
                getAgentVendorResumeId(
                    { codexSessionId: 'x1' },
                    alias,
                    { accountSettings: { codexBackendMode: 'acp' } },
                ),
            ).toBe('x1');
        }
    });
});

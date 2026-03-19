import { buildBackendTargetKey } from '@happier-dev/protocol';
import { describe, expect, test } from 'vitest';

import { canAgentResume, canResumeSession, canResumeSessionWithOptions, getAgentVendorResumeId } from './resumeCapabilities';

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

    test('returns Codex session id when appServer resume is enabled for Codex by settings', () => {
        expect(getAgentVendorResumeId(
            { codexSessionId: 'x1' },
            'codex',
            { accountSettings: { codexBackendMode: 'appServer' } },
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

describe('configured ACP resume capability', () => {
    test('treats configured ACP flavors as resumable attach targets without vendor resume ids', () => {
        expect(canAgentResume('acp:custom-backend')).toBe(true);
        expect(canAgentResume('acp:')).toBe(false);
        expect(canAgentResume('acp:   ')).toBe(false);
        expect(canResumeSessionWithOptions({
            flavor: 'acp:custom-backend',
            acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 123,
                backendId: 'custom-backend',
                title: 'Custom Kiro',
            },
        })).toBe(true);
        expect(canResumeSessionWithOptions({ flavor: 'acp:' })).toBe(false);
        expect(getAgentVendorResumeId({
            acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 123,
                backendId: 'custom-backend',
                title: 'Custom Kiro',
            },
        }, 'acp:custom-backend')).toBeNull();
    });

    test('keeps ACP attach resume enabled when runtime descriptors also resolve to a provider agent', () => {
        const metadata = {
            flavor: 'acp:custom-backend',
            acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 123,
                backendId: 'custom-backend',
                title: 'Custom Kiro',
            },
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    vendorSessionId: 'x1',
                },
            },
            codexSessionId: 'x1',
        } as const;

        expect(canResumeSession(metadata)).toBe(true);
        expect(canResumeSessionWithOptions(metadata, { accountSettings: { codexBackendMode: 'mcp' } })).toBe(true);
    });

    test('does not expose vendor resume ids for ACP attach sessions even when runtime descriptors include one', () => {
        const metadata = {
            flavor: 'acp:custom-backend',
            acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 123,
                backendId: 'custom-backend',
                title: 'Custom Kiro',
            },
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    vendorSessionId: 'x1',
                },
            },
            codexSessionId: 'x1',
        } as const;

        expect(getAgentVendorResumeId(metadata, 'acp:custom-backend', { accountSettings: { codexBackendMode: 'acp' } })).toBeNull();
        expect(getAgentVendorResumeId(metadata, 'codex', { accountSettings: { codexBackendMode: 'acp' } })).toBeNull();
    });

    test('fails closed when the configured ACP backend target is disabled', () => {
        const options = {
            accountSettings: {
                backendEnabledByTargetKey: {
                    [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-backend' })]: false,
                },
            },
        };

        expect(canAgentResume('acp:custom-backend', options)).toBe(false);
        expect(canResumeSessionWithOptions({
            flavor: 'acp:custom-backend',
            acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 123,
                backendId: 'custom-backend',
                title: 'Custom Kiro',
            },
        }, options)).toBe(false);
    });

    test('allows configured ACP resume when the backend target remains enabled', () => {
        const options = {
            accountSettings: {
                backendEnabledByTargetKey: {
                    [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-backend' })]: true,
                },
            },
        };

        expect(canAgentResume('acp:custom-backend', options)).toBe(true);
        expect(canResumeSessionWithOptions({
            flavor: 'acp:custom-backend',
            acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 123,
                backendId: 'custom-backend',
                title: 'Custom Kiro',
            },
        }, options)).toBe(true);
    });
});

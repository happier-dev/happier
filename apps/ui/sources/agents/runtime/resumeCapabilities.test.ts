import { buildBackendTargetKey } from '@happier-dev/protocol';
import { describe, expect, test } from 'vitest';

import { canAgentResume, canContinueSessionWithFreshSpawn, canResumeSession, canResumeSessionWithOptions, getAgentVendorResumeId } from './resumeCapabilities';

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

    test('returns null for Codex vendor resume when disabled by settings', () => {
        expect(getAgentVendorResumeId(
            { codexSessionId: 'x1' },
            'codex',
            { accountSettings: { codexBackendMode: 'mcp' } },
        )).toBeNull();
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

    test('returns Pi session id when metadata contains it', () => {
        expect(getAgentVendorResumeId({ piSessionId: 'p1' }, 'pi')).toBe('p1');
    });

    test('marks Pi sessions as resumable when metadata contains a session id', () => {
        expect(canAgentResume('pi')).toBe(true);
        expect(canResumeSessionWithOptions({ flavor: 'pi', piSessionId: 'p1' })).toBe(true);
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
    const configuredBackend = {
        id: 'custom-backend',
        name: 'custom-backend',
        title: 'Custom backend',
        command: 'custom-agent',
        args: [],
        env: {},
        transportProfile: 'generic' as const,
        capabilities: {
            supportsLoadSession: true,
            supportsModes: 'unknown' as const,
            supportsModels: 'unknown' as const,
            supportsConfigOptions: 'unknown' as const,
            promptImageSupport: 'unknown' as const,
        },
        createdAt: 1,
        updatedAt: 1,
    };
    const metadata = {
        flavor: 'acp:misleading-flavor',
        acpConfiguredBackendV1: {
            v: 1 as const,
            updatedAt: 123,
            backendId: 'custom-backend',
            title: 'Custom backend',
        },
        customAcpSessionId: 'provider-session-1',
    };
    const enabledOptions = {
        accountSettings: {
            acpCatalogSettingsV1: { v: 2 as const, backends: [configuredBackend] },
            backendEnabledByTargetKey: {
                [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-backend' })]: true,
            },
        },
    };

    test('does not infer configured resume authority from flavor alone', () => {
        expect(canAgentResume('acp:custom-backend')).toBe(false);
        expect(canAgentResume('acp:')).toBe(false);
        expect(canAgentResume('acp:   ')).toBe(false);
        expect(canResumeSessionWithOptions({ flavor: 'acp:custom-backend' }, enabledOptions)).toBe(false);
        expect(canResumeSessionWithOptions({ flavor: 'acp:' })).toBe(false);
    });

    test('fails closed without a catalog entry, static load support, or provider session id', () => {
        expect(canResumeSessionWithOptions(metadata, { accountSettings: {} })).toBe(false);
        expect(canResumeSessionWithOptions(metadata, {
            accountSettings: {
                acpCatalogSettingsV1: {
                    v: 2,
                    backends: [{
                        ...configuredBackend,
                        capabilities: { ...configuredBackend.capabilities, supportsLoadSession: false },
                    }],
                },
            },
        })).toBe(false);
        expect(canResumeSessionWithOptions({ ...metadata, customAcpSessionId: ' ' }, enabledOptions)).toBe(false);
    });

    test('requires exact metadata identity instead of a matching flavor', () => {
        expect(canResumeSessionWithOptions({
            ...metadata,
            flavor: 'acp:custom-backend',
            acpConfiguredBackendV1: { ...metadata.acpConfiguredBackendV1, backendId: 'other-backend' },
        }, enabledOptions)).toBe(false);
    });

    test('fails closed when the configured ACP backend target is disabled', () => {
        const options = {
            accountSettings: {
                acpCatalogSettingsV1: { v: 2 as const, backends: [configuredBackend] },
                backendEnabledByTargetKey: {
                    [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-backend' })]: false,
                },
            },
        };

        expect(canAgentResume('acp:custom-backend', options)).toBe(false);
        expect(canResumeSessionWithOptions(metadata, options)).toBe(false);
    });

    test('allows configured resume when exact metadata and static catalog policy agree despite a misleading flavor', () => {
        expect(canResumeSessionWithOptions(metadata, enabledOptions)).toBe(true);
        expect(canResumeSession(metadata)).toBe(false);
        expect(getAgentVendorResumeId(metadata, 'acp:custom-backend', enabledOptions)).toBeNull();
    });
});

describe('canContinueSessionWithFreshSpawn', () => {
    test('continuable when the agent supports vendor resume but no vendor id was ever persisted (pre-SessionStart death, QA A-F5)', () => {
        expect(canContinueSessionWithFreshSpawn({ flavor: 'claude' })).toBe(true);
    });

    test('not the fresh-spawn case once a vendor resume id exists', () => {
        expect(canContinueSessionWithFreshSpawn({ flavor: 'claude', claudeSessionId: 'c1' })).toBe(false);
    });

    test('not continuable for unknown flavors', () => {
        expect(canContinueSessionWithFreshSpawn({ flavor: 'mystery-agent' })).toBe(false);
        expect(canContinueSessionWithFreshSpawn(null)).toBe(false);
    });

    test('continuable even when experimental vendor resume is disabled by settings (fresh spawn needs no resume support)', () => {
        expect(canContinueSessionWithFreshSpawn(
            { flavor: 'codex' },
            { accountSettings: { codexBackendMode: 'mcp' } },
        )).toBe(true);
    });

    test('configured ACP flavors are governed by the normal resume gate, not the fresh-spawn gate', () => {
        expect(canContinueSessionWithFreshSpawn({ flavor: 'acp:custom-backend' })).toBe(false);
    });
});

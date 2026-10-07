import { describe, expect, test } from 'vitest';

import {
    canAgentResume,
    canContinueSessionWithFreshSpawn,
    canResumeOrContinueSessionWithOptions,
    canResumeSession,
    canResumeSessionWithOptions,
    getAgentSessionId,
    getAgentVendorResumeId,
} from './resumeCapabilities';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

const projectedExternalLifecycleCapabilities = {
    agentId: 'acme-lifecycle',
    identity: {
        pluginId: 'acme.lifecycle',
        localId: 'acme-lifecycle',
    },
    generation: 42,
    capabilities: {
        surfaces: ['terminal'],
        sessions: {
            open: ['create', 'resume', 'fork'],
            delivery: ['newTurn', 'steer', 'followUp'],
            cancel: true,
            conversationRollback: true,
            usageLimitRecovery: {
                active: ['checkNow'],
                inactive: ['checkNow', 'consumeResetCredit'],
            },
        },
        executionRuns: {
            open: ['create', 'resume', 'fork'],
            checkpoint: true,
            stop: true,
        },
    },
} as const;

const projectedExternalLifecycleOptions = {
    currentAgentCapabilities: projectedExternalLifecycleCapabilities,
} as unknown as Parameters<typeof canResumeSessionWithOptions>[1];

describe('projected external Agent resume capability', () => {
    const externalRuntimeMetadata = {
        runtimeDescriptorV1: {
            v: 1,
            agentId: 'acme-lifecycle',
            agent: {
                providerSessionId: 'acme-session-1',
            },
        },
        nativeResumeIdentityV1: { v: 1, vendorResumeId: 'acme-session-1' },
    } as const;

    test('resumes through the exact current declaration and generic runtime descriptor', () => {
        expect(canResumeSessionWithOptions(
            externalRuntimeMetadata,
            projectedExternalLifecycleOptions,
        )).toBe(true);
        expect(getAgentVendorResumeId(
            externalRuntimeMetadata,
            'acme-lifecycle',
            projectedExternalLifecycleOptions,
        )).toBe('acme-session-1');
    });

    test('uses declared create for pre-start recovery without a provider session id', () => {
        expect(canContinueSessionWithFreshSpawn({
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'acme-lifecycle',
                agent: {},
            },
        }, projectedExternalLifecycleOptions)).toBe(true);
    });

    test('fails closed for missing or stale current declaration backing', () => {
        expect(canResumeSessionWithOptions(externalRuntimeMetadata)).toBe(false);
        expect(canResumeSessionWithOptions(externalRuntimeMetadata, {
            currentAgentCapabilities: {
                ...projectedExternalLifecycleCapabilities,
                agentId: 'acme-other',
            },
        } as unknown as Parameters<typeof canResumeSessionWithOptions>[1])).toBe(false);
    });
});

describe('getAgentVendorResumeId', () => {
    const currentAntigravityAgent = {
        identity: {
            pluginId: 'happier.agent.antigravity',
            localId: 'antigravity',
        },
        sourceKinds: ['antigravityCliPrint'],
    };
    const linkedAntigravityMetadata = {
        flavor: 'antigravity',
        antigravitySessionId: 'conversation-1',
        externalSessionV1: {
            v: 1,
            agentId: 'antigravity',
            machineId: 'machine-1',
            remoteSessionId: 'conversation-1',
            source: {
                kind: 'antigravityCliPrint',
                brainDir: '/tmp/antigravity-brain',
            },
            qualifiedIdentity: {
                v: 1,
                agent: {
                    pluginId: 'happier.agent.antigravity',
                    localId: 'antigravity',
                },
                source: {
                    kind: 'antigravityCliPrint',
                    contractVersion: 1,
                },
            },
        },
    };

    test('returns null when metadata missing', () => {
        expect(getAgentVendorResumeId(null, 'claude')).toBeNull();
    });

    test('returns null when agent is not resumable', () => {
        expect(getAgentVendorResumeId({ claudeSessionId: 'c1' }, 'gemini')).toBeNull();
    });

    test('returns the Claude session id without treating the transcript path as a resume gate', () => {
        expect(getAgentVendorResumeId({ claudeSessionId: 'c1' }, 'claude')).toBe('c1');
        expect(getAgentVendorResumeId({
            claudeSessionId: 'c1',
            claudeTranscriptPath: '/tmp/c1.jsonl',
        }, 'claude')).toBe('c1');
    });

    test('does not gate runtime-checked Codex resume on the retired backend-mode setting', () => {
        expect(getAgentVendorResumeId(
            { codexSessionId: 'x1' },
            'codex',
            { accountSettings: { codexBackendMode: 'mcp' } },
        )).toBe('x1');
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

    test('returns Cursor session id when runtime-checked resume metadata contains it', () => {
        expect(getAgentVendorResumeId({ cursorSessionId: 'cursor-1' }, 'cursor')).toBe('cursor-1');
    });

    test('marks Cursor sessions as resumable when metadata contains a session id', () => {
        expect(canAgentResume('cursor')).toBe(true);
        expect(canResumeSessionWithOptions({ flavor: 'cursor', cursorSessionId: 'cursor-1' })).toBe(true);
    });

    test('treats blank ids as missing and preserves opaque Agent-minted identity bytes', () => {
        expect(getAgentVendorResumeId({ claudeSessionId: '' }, 'claude')).toBeNull();
        expect(getAgentVendorResumeId({
            claudeSessionId: ' c1 ',
            claudeTranscriptPath: ' /tmp/c1.jsonl ',
        }, 'claude')).toBe(' c1 ');
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

    test('uses canonical runtime metadata before stale flavor when reading session id', () => {
        expect(getAgentSessionId({
            flavor: 'claude',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'opencode',
                provider: {
                    providerSessionId: 'opencode-1',
                },
            },
            claudeSessionId: 'claude-1',
            opencodeSessionId: 'opencode-1',
        })).toBe('opencode-1');
    });

    test('does not return a vendor resume id when explicit agent conflicts with declared runtime owner', () => {
        expect(getAgentVendorResumeId({
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'opencode',
                provider: {
                    providerSessionId: 'opencode-1',
                },
            },
            claudeSessionId: 'claude-1',
            opencodeSessionId: 'opencode-1',
        }, 'claude')).toBeNull();
    });

    test('does not return a vendor resume id when explicit agent conflicts with direct session owner', () => {
        expect(getAgentVendorResumeId({
            directSessionV1: {
                v: 1,
                providerId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'opencode-1',
                source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' },
            },
            claudeSessionId: 'claude-1',
            opencodeSessionId: 'opencode-1',
        }, 'claude')).toBeNull();
    });

    test('does not return a vendor resume id when explicit agent conflicts with canonical external-session owner', () => {
        expect(getAgentVendorResumeId({
            externalSessionV1: {
                v: 1,
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'opencode-1',
                source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' },
            },
            claudeSessionId: 'claude-1',
            opencodeSessionId: 'opencode-1',
        }, 'claude')).toBeNull();
    });

    test('fails linked vendor resume closed without the current daemon Agent identity', () => {
        expect(getAgentVendorResumeId(
            linkedAntigravityMetadata,
            'antigravity',
        )).toBeNull();
        expect(canResumeSessionWithOptions(linkedAntigravityMetadata)).toBe(false);
    });

    test('rejects stale linked ids and allows a fully current linked resume identity', () => {
        expect(getAgentVendorResumeId(
            {
                ...linkedAntigravityMetadata,
                antigravitySessionId: 'stale-conversation',
            },
            'antigravity',
            { linkedSessionCurrentAgent: currentAntigravityAgent },
        )).toBeNull();
        expect(getAgentVendorResumeId(
            linkedAntigravityMetadata,
            'antigravity',
            { linkedSessionCurrentAgent: currentAntigravityAgent },
        )).toBe('conversation-1');
        expect(canResumeSessionWithOptions(
            linkedAntigravityMetadata,
            { linkedSessionCurrentAgent: currentAntigravityAgent },
        )).toBe(true);
    });
});

describe('configured ACP resume capability', () => {
    function configuredBackendDeclaration(params: Readonly<{
        id: string;
        capabilities?: Record<string, unknown>;
    }>): Record<string, unknown> {
        return {
            id: params.id,
            name: params.id,
            title: `Custom ${params.id}`,
            command: 'custom-acp',
            args: [],
            env: {},
            ...(params.capabilities ? { capabilities: params.capabilities } : {}),
            createdAt: 1,
            updatedAt: 2,
        };
    }

    function optionsWithCatalog(
        backends: readonly Record<string, unknown>[],
        extraAccountSettings?: Record<string, unknown>,
    ): Parameters<typeof canResumeSessionWithOptions>[1] {
        return {
            accountSettings: {
                acpCatalogSettingsV1: { v: 2, backends: [...backends] },
                ...extraAccountSettings,
            },
        };
    }

    const loadCapableCatalog = optionsWithCatalog([
        configuredBackendDeclaration({ id: 'custom-backend', capabilities: { supportsLoadSession: true } }),
    ]);

    const configuredAcpMetadata = {
        flavor: 'acp:custom-backend',
        acpConfiguredBackendV1: {
            v: 1,
            updatedAt: 123,
            backendId: 'custom-backend',
            title: 'Custom Kiro',
        },
    } as const;

    test('fails closed when the Account declaration does not support session load', () => {
        // No Account catalog reached this reader at all.
        expect(canAgentResume('acp:custom-backend')).toBe(false);
        expect(canResumeSessionWithOptions(configuredAcpMetadata)).toBe(false);

        // Declared backend with no capabilities block: absence is not support.
        const withoutCapabilities = optionsWithCatalog([
            configuredBackendDeclaration({ id: 'custom-backend' }),
        ]);
        expect(canAgentResume('acp:custom-backend', withoutCapabilities)).toBe(false);
        expect(canResumeSessionWithOptions(configuredAcpMetadata, withoutCapabilities)).toBe(false);

        // Explicitly declared unsupported.
        const explicitlyUnsupported = optionsWithCatalog([
            configuredBackendDeclaration({ id: 'custom-backend', capabilities: { supportsLoadSession: false } }),
        ]);
        expect(canAgentResume('acp:custom-backend', explicitlyUnsupported)).toBe(false);
        expect(canResumeSessionWithOptions(configuredAcpMetadata, explicitlyUnsupported)).toBe(false);
    });

    test('resumes only when the exact declared backend supports session load', () => {
        expect(canAgentResume('acp:custom-backend', loadCapableCatalog)).toBe(true);
        expect(canResumeSessionWithOptions(configuredAcpMetadata, loadCapableCatalog)).toBe(true);

        // A different backend's support never authorizes this one.
        const otherBackendOnly = optionsWithCatalog([
            configuredBackendDeclaration({ id: 'other-backend', capabilities: { supportsLoadSession: true } }),
        ]);
        expect(canAgentResume('acp:custom-backend', otherBackendOnly)).toBe(false);
        expect(canResumeSessionWithOptions(configuredAcpMetadata, otherBackendOnly)).toBe(false);
    });

    test('canonical configured metadata outranks a conflicting flavor carrier', () => {
        const metadata = {
            flavor: 'acp:other-backend',
            acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 123,
                backendId: 'custom-backend',
                title: 'Custom Kiro',
            },
        } as const;

        expect(canResumeSessionWithOptions(metadata, optionsWithCatalog([
            configuredBackendDeclaration({ id: 'custom-backend', capabilities: { supportsLoadSession: true } }),
            configuredBackendDeclaration({ id: 'other-backend', capabilities: { supportsLoadSession: false } }),
        ]))).toBe(true);

        expect(canResumeSessionWithOptions(metadata, optionsWithCatalog([
            configuredBackendDeclaration({ id: 'custom-backend', capabilities: { supportsLoadSession: false } }),
            configuredBackendDeclaration({ id: 'other-backend', capabilities: { supportsLoadSession: true } }),
        ]))).toBe(false);
    });

    test('canonical configured metadata decides when the flavor carrier is absent or malformed', () => {
        expect(canResumeSessionWithOptions({
            acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 123,
                backendId: 'custom-backend',
                title: 'Custom Kiro',
            },
        }, loadCapableCatalog)).toBe(true);

        expect(canResumeSessionWithOptions({
            flavor: 'acp:',
            acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 123,
                backendId: 'custom-backend',
                title: 'Custom Kiro',
            },
        }, loadCapableCatalog)).toBe(true);
    });

    test('reads the released `acp:` carrier only when canonical metadata is absent', () => {
        expect(canResumeSessionWithOptions({ flavor: 'acp:custom-backend' }, loadCapableCatalog)).toBe(true);
        expect(canResumeSessionWithOptions({ flavor: 'acp:custom-backend' }, optionsWithCatalog([
            configuredBackendDeclaration({ id: 'custom-backend', capabilities: { supportsLoadSession: false } }),
        ]))).toBe(false);
    });

    test('does not let configured ACP attach bypass canonical linked-session identity', () => {
        expect(canResumeSessionWithOptions({
            flavor: 'acp:custom-backend',
            acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 123,
                backendId: 'custom-backend',
                title: 'Custom Backend',
            },
            pluginSessionId: 'plugin-session-1',
            externalSessionV1: {
                v: 1,
                agentId: 'plugin-provider',
                machineId: 'machine-1',
                remoteSessionId: 'plugin-session-1',
                source: {
                    kind: 'pluginTranscript',
                },
                qualifiedIdentity: {
                    v: 1,
                    agent: {
                        pluginId: 'acme.plugin-provider',
                        localId: 'plugin-provider',
                    },
                    source: {
                        kind: 'pluginTranscript',
                        contractVersion: 1,
                    },
                },
            },
        }, loadCapableCatalog)).toBe(false);
    });

    test('does not let configured ACP attach bypass a released linked-session identity', () => {
        expect(canResumeSessionWithOptions({
            flavor: 'acp:custom-backend',
            acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 123,
                backendId: 'custom-backend',
                title: 'Custom Backend',
            },
            pluginSessionId: 'plugin-session-1',
            directSessionV1: {
                v: 1,
                providerId: 'plugin-provider',
                machineId: 'machine-1',
                remoteSessionId: 'plugin-session-1',
                source: { kind: 'pluginTranscript' },
            },
        }, loadCapableCatalog)).toBe(false);
    });

    test('treats declared configured ACP backends as resumable attach targets without vendor resume ids', () => {
        expect(canAgentResume('acp:custom-backend', loadCapableCatalog)).toBe(true);
        expect(canAgentResume('acp:', loadCapableCatalog)).toBe(false);
        expect(canAgentResume('acp:   ', loadCapableCatalog)).toBe(false);
        expect(canResumeSessionWithOptions(configuredAcpMetadata, loadCapableCatalog)).toBe(true);
        expect(canResumeSessionWithOptions({ flavor: 'acp:' }, loadCapableCatalog)).toBe(false);
        expect(getAgentVendorResumeId({
            acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 123,
                backendId: 'custom-backend',
                title: 'Custom Kiro',
            },
        }, 'acp:custom-backend', loadCapableCatalog)).toBeNull();
    });

    test('keeps the configured ACP decision when runtime descriptors also resolve to a provider agent', () => {
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
                agentId: 'codex',
                provider: {
                    providerSessionId: 'x1',
                },
            },
            codexSessionId: 'x1',
        } as const;

        expect(canResumeSession(metadata)).toBe(false);
        expect(canResumeSessionWithOptions(metadata, {
            accountSettings: {
                ...(loadCapableCatalog?.accountSettings ?? {}),
                codexBackendMode: 'mcp',
            },
        })).toBe(true);
        // An undeclared configured backend must not fall through to the Codex
        // vendor-resume rule just because the Session also carries Codex keys.
        expect(canResumeSessionWithOptions(metadata, {
            accountSettings: {
                acpCatalogSettingsV1: { v: 2, backends: [] },
                codexBackendMode: 'acp',
            },
        })).toBe(false);
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
                agentId: 'codex',
                provider: {
                    providerSessionId: 'x1',
                },
            },
            codexSessionId: 'x1',
        } as const;

        expect(getAgentVendorResumeId(metadata, 'acp:custom-backend', { accountSettings: { codexBackendMode: 'acp' } })).toBeNull();
        expect(getAgentVendorResumeId(metadata, 'codex', { accountSettings: { codexBackendMode: 'acp' } })).toBeNull();
    });

    test('fails closed when the configured ACP backend target is disabled', () => {
        const options = optionsWithCatalog(
            [configuredBackendDeclaration({ id: 'custom-backend', capabilities: { supportsLoadSession: true } })],
            {
                backendEnabledByTargetKey: {
                    [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'custom-backend', configuredBackendId: 'custom-backend' })]: false,
                },
            },
        );

        expect(canAgentResume('acp:custom-backend', options)).toBe(false);
        expect(canResumeSessionWithOptions(configuredAcpMetadata, options)).toBe(false);
    });

    test('allows configured ACP resume when the declared backend target remains enabled', () => {
        const options = optionsWithCatalog(
            [configuredBackendDeclaration({ id: 'custom-backend', capabilities: { supportsLoadSession: true } })],
            {
                backendEnabledByTargetKey: {
                    [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'custom-backend', configuredBackendId: 'custom-backend' })]: true,
                },
            },
        );

        expect(canAgentResume('acp:custom-backend', options)).toBe(true);
        expect(canResumeSessionWithOptions(configuredAcpMetadata, options)).toBe(true);
    });
});

describe('canContinueSessionWithFreshSpawn', () => {
    test('does not bypass linked-session resume identity by treating a missing top-level id as pre-start', () => {
        const metadata = {
            flavor: 'antigravity',
            externalSessionV1: {
                v: 1,
                agentId: 'antigravity',
                machineId: 'machine-1',
                remoteSessionId: 'conversation-1',
                source: {
                    kind: 'antigravityCliPrint',
                    brainDir: '/tmp/antigravity-brain',
                },
                qualifiedIdentity: {
                    v: 1,
                    agent: {
                        pluginId: 'happier.agent.antigravity',
                        localId: 'antigravity',
                    },
                    source: {
                        kind: 'antigravityCliPrint',
                        contractVersion: 1,
                    },
                },
            },
        };

        expect(canContinueSessionWithFreshSpawn(metadata)).toBe(false);
        expect(canResumeOrContinueSessionWithOptions(metadata, {
            linkedSessionCurrentAgent: {
                identity: {
                    pluginId: 'happier.agent.antigravity',
                    localId: 'antigravity',
                },
                sourceKinds: ['antigravityCliPrint'],
            },
        })).toBe(false);
    });

    test('does not treat a released linked session as a fresh pre-start session', () => {
        expect(canContinueSessionWithFreshSpawn({
            flavor: 'antigravity',
            directSessionV1: {
                v: 1,
                providerId: 'antigravity',
                machineId: 'machine-1',
                remoteSessionId: 'conversation-1',
                source: {
                    kind: 'antigravityCliPrint',
                    brainDir: '/tmp/antigravity-brain',
                },
            },
        })).toBe(false);
    });

    test('continuable when the agent supports vendor resume but no vendor id was ever persisted (pre-SessionStart death, QA A-F5)', () => {
        expect(canContinueSessionWithFreshSpawn({ flavor: 'claude' })).toBe(true);
    });

    test('not continuable for a replay fork after the replay seed was consumed without a vendor resume id', () => {
        expect(canContinueSessionWithFreshSpawn({
            flavor: 'claude',
            forkV1: {
                v: 1,
                parentSessionId: 'parent-session',
                parentCutoffSeqInclusive: 7,
                createdAtMs: 1000,
                strategy: 'replay',
                providerHint: { providerId: 'claude' },
            },
            replaySeedV1: {
                v: 1,
                seedText: '',
                sourceSessionId: 'parent-session',
                sourceCutoffSeqInclusive: 7,
                createdAtMs: 1000,
                appliedToLocalId: 'local-1',
                appliedAtMs: 2000,
            },
        })).toBe(false);
    });

    test('continuable for a replay fork while the replay seed is still unconsumed', () => {
        expect(canContinueSessionWithFreshSpawn({
            flavor: 'claude',
            forkV1: {
                v: 1,
                parentSessionId: 'parent-session',
                parentCutoffSeqInclusive: 7,
                createdAtMs: 1000,
                strategy: 'replay',
                providerHint: { providerId: 'claude' },
            },
            replaySeedV1: {
                v: 1,
                seedText: 'Replay context',
                sourceSessionId: 'parent-session',
                sourceCutoffSeqInclusive: 7,
                createdAtMs: 1000,
            },
        })).toBe(true);
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

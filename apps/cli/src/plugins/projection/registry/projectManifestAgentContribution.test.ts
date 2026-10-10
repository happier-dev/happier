import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

const { runBackendSessionCliCommand } = vi.hoisted(() => ({
    runBackendSessionCliCommand: vi.fn(async () => {}),
}));

vi.mock('@/cli/runBackendSessionCliCommand', () => ({
    runBackendSessionCliCommand,
}));

import { createNativeInactiveUsageAdapter } from '@/agent/catalog/nativeInactiveSessionControlAdapters';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

import { projectManifestAgentAcpCatalogPreflight, projectManifestAgentContribution } from './projectManifestAgentContribution';

function project(definition: unknown, provenance: 'external' | 'first_party' = 'external') {
    return projectManifestAgentContribution({
        definition: PluginAgentContributionV2Schema.parse(definition),
        provenance,
        source: provenance === 'first_party' ? { kind: 'bundled' } : { kind: 'path' },
        pluginId: provenance === 'first_party' ? 'happier.agent.codex' : 'com.acme.agent',
    });
}

function sessionAgent(open: readonly ('create' | 'resume' | 'fork')[]) {
    return {
        id: 'acme-agent',
        title: 'Acme Agent',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: {
            sessions: {
                open,
                delivery: ['newTurn'],
                cancel: true,
            },
        },
    };
}

describe('projectManifestAgentContribution', () => {
    it('consumes declarative ACP recovery policy through the shared host backoff owner', async () => {
        const contribution = project({ ...sessionAgent(['create', 'resume']), runtime: {
            kind: 'acp', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture-acp' } },
            definition: { usageLimitRecoveryBackoff: {
                fallbackBackoffEnvKey: 'HAPPIER_TEST_ACP_FALLBACK_MS', maxAttemptsEnvKey: 'HAPPIER_TEST_ACP_MAX_ATTEMPTS',
            } },
        } });
        const policy = contribution.catalogEntry?.sessionUsageLimitRecoveryBackoffPolicy;
        expect(policy).toMatchObject({ providerId: contribution.id, issueProviderFilter: contribution.id });
        const adapter = createNativeInactiveUsageAdapter({ agentId: contribution.id, backoffPolicy: policy,
            native: { checkNow: false, consumeResetCredit: false } });
        const occurredAt = Date.now();
        // Raw HTTP session state is a genuine host boundary; projection/backoff are real.
        const rawSession = { id: 'quota-session', active: false, encryptionMode: 'plain', latestTurnStatus: 'failed',
            lastRuntimeIssue: { v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
                agentId: contribution.id, occurredAt, usageLimit: { v: 1, resetAtMs: null, retryAfterMs: null,
                    quotaScope: 'account', recoverability: 'wait', connectedService: {
                        serviceId: 'com.acme.agent/account', profileId: 'selected-profile', groupId: 'selected-pool',
                    } } },
        } as RawSessionRecord;
        expect(await adapter.checkNow?.({ token: 'token', sessionId: rawSession.id, rawSession, metadata: {},
            currentMachineId: 'machine', sessionMachineId: 'machine', cwd: '/repo', ctx: null, mode: 'plain' })).toMatchObject({
            ok: true, status: 'waiting', metadata: { sessionUsageLimitRecoveryV1: { maxAttempts: 3,
                selectedAuth: { kind: 'group', serviceId: 'com.acme.agent/account', groupId: 'selected-pool', profileId: 'selected-profile' },
            } },
        });
    });

    it('does not create ACP preflight controls for a surface-only Agent', () => {
        const declaration = PluginAgentContributionV2Schema.parse({
            id: 'acme-external',
            title: 'Acme External',
            capabilities: { surfaces: ['externalSessions'] },
            surfaces: {
                externalSession: {
                    sources: [{
                        sourceKind: 'fixture',
                        schema: { fields: [{ name: 'kind', kind: 'literal', value: 'fixture' }] },
                        key: { segments: [{ kind: 'literal', value: 'fixture' }] },
                        instances: [{ kind: 'default', constants: {} }],
                    }],
                },
            },
        });

        expect(projectManifestAgentAcpCatalogPreflight(declaration, 'com.acme.agent')).toBeNull();
    });

    it('projects a session-capable manifest Agent without CLI metadata into the catalog and generic host session command', async () => {
        const contribution = project(sessionAgent(['create', 'resume']));

        expect(contribution.runtimeSpec).toBeNull();
        expect(contribution.id).toBe('com.acme.agent/acme-agent');
        expect(contribution.identity).toEqual({ pluginId: 'com.acme.agent', localId: 'acme-agent' });
        expect(contribution.catalogEntry).toMatchObject({
            id: 'com.acme.agent/acme-agent',
            cliSubcommand: 'com.acme.agent/acme-agent',
            vendorResumeSupport: 'supported',
        });
        expect(contribution.catalogEntry).not.toHaveProperty('getCliDetect');
        expect(contribution.catalogEntry).not.toHaveProperty('getCliAuthSpec');

        const getCliCommandHandler = contribution.catalogEntry?.getCliCommandHandler;
        expect(getCliCommandHandler).toBeTypeOf('function');
        if (!getCliCommandHandler) throw new Error('Expected generic Session command handler');

        const handler = await getCliCommandHandler();
        await handler({
            args: ['com.acme.agent/acme-agent', '--happy-starting-mode', 'remote'],
            rawArgv: ['happier', 'com.acme.agent/acme-agent', '--happy-starting-mode', 'remote'],
            terminalRuntime: null,
        });

        expect(runBackendSessionCliCommand).toHaveBeenCalledWith({
            context: {
                args: ['com.acme.agent/acme-agent', '--happy-starting-mode', 'remote'],
                rawArgv: ['happier', 'com.acme.agent/acme-agent', '--happy-starting-mode', 'remote'],
                terminalRuntime: null,
            },
            backendIdForSessionRuntime: 'com.acme.agent/acme-agent',
            runtimeAuthorityAgentId: 'com.acme.agent/acme-agent',
            agentIdForAccountSettings: 'com.acme.agent/acme-agent',
            isExplicitCliSubcommand: true,
        });
    });

    it('derives resume eligibility and projects finite Agents while keeping auxiliary-only Agents out of the catalog', () => {
        const noResumeSessionAgent = project(sessionAgent(['create']));
        const executionOnlyAgent = project({
            id: 'acme-execution',
            title: 'Acme Execution',
            runtime: { kind: 'custom' },
            primary: 'executionRuns',
            capabilities: {
                executionRuns: {
                    open: ['create'],
                    checkpoint: false,
                    stop: true,
                },
            },
        });
        const auxiliaryOnlyAgent = project({
            id: 'acme-auxiliary',
            title: 'Acme Auxiliary',
            capabilities: { surfaces: ['externalSessions'] },
            surfaces: {
                externalSession: {
                    sources: [{
                        sourceKind: 'fixture',
                        schema: { fields: [{ name: 'kind', kind: 'literal', value: 'fixture' }] },
                        key: { segments: [{ kind: 'literal', value: 'fixture' }] },
                        instances: [{ kind: 'default', constants: {} }],
                    }],
                },
            },
        });

        expect(noResumeSessionAgent.catalogEntry?.vendorResumeSupport).toBe('unsupported');
        expect(executionOnlyAgent.catalogEntry).toMatchObject({
            id: 'com.acme.agent/acme-execution',
            cliSubcommand: 'com.acme.agent/acme-execution',
            vendorResumeSupport: 'unsupported',
        });
        expect(auxiliaryOnlyAgent.catalogEntry).toBeNull();
    });

    it('projects CLI detection and auth only for a Session Agent that declares CLI metadata', async () => {
        const contribution = project({
            ...sessionAgent(['create']),
            cli: {
                executable: {
                    binaryName: 'acme-agent',
                    sourcePreference: 'system-first',
                },
                install: {
                    manual: { kind: 'none' },
                },
                auth: {
                    support: 'status_only',
                    loginLaunches: [],
                },
            },
        });

        expect(contribution.runtimeSpec).toMatchObject({
            id: 'com.acme.agent/acme-agent',
            binaryName: 'acme-agent',
        });
        const getCliDetect = contribution.catalogEntry?.getCliDetect;
        expect(getCliDetect).toBeTypeOf('function');
        expect(contribution.catalogEntry?.getCliAuthSpec).toBeTypeOf('function');
        if (!getCliDetect) throw new Error('Expected declared CLI detection metadata');
        await expect(getCliDetect()).resolves.toMatchObject({
            versionArgsToTry: [['--version'], ['version'], ['-v']],
            loginStatusArgs: null,
        });
    });

    it('keeps an external Agent off the legacy service-keyed projection even when it targets a built-in service', () => {
        // `connectedServiceIds` is the host-private legacy compatibility input:
        // it routes an Agent onto the service-keyed credential owner and earns
        // the request-auth `legacyServiceKeyedCompatibility` certificate. An
        // external manifest declaring a built-in service ref proves nothing
        // about provenance, so it stays on the qualified purpose owner.
        const contribution = project({
            ...sessionAgent(['create']),
            connectedAccounts: [{
                purpose: 'codex',
                service: {
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                },
            }, {
                purpose: 'local',
                service: 'anthropic',
            }],
        });

        expect(contribution.catalogEntry).not.toHaveProperty('connectedServiceIds');
        expect(contribution.catalogEntry?.connectedAccountServiceIds).toEqual([
            'happier.agent.codex/openai-codex',
            'com.acme.agent/anthropic',
        ]);
    });

    it('projects exact legacy-compatible Connected Service ids for the retained first-party legacy adapter', () => {
        const contribution = project({
            ...sessionAgent(['create']),
            connectedAccounts: [{
                purpose: 'codex',
                service: {
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                },
            }, {
                purpose: 'local',
                service: 'anthropic',
            }],
        }, 'first_party');

        expect(contribution.catalogEntry?.connectedServiceIds).toEqual([
            'openai-codex',
        ]);
        expect(contribution.catalogEntry?.connectedAccountServiceIds).toEqual([
            'happier.agent.codex/openai-codex',
            'happier.agent.codex/anthropic',
        ]);
    });
});

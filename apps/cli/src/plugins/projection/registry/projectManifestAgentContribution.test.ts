import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

const { runBackendSessionCliCommand } = vi.hoisted(() => ({
    runBackendSessionCliCommand: vi.fn(async () => {}),
}));

vi.mock('@/cli/runBackendSessionCliCommand', () => ({
    runBackendSessionCliCommand,
}));

import { projectManifestAgentContribution } from './projectManifestAgentContribution';

function project(definition: unknown) {
    return projectManifestAgentContribution({
        definition: PluginAgentContributionV2Schema.parse(definition),
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: 'com.acme.agent',
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
        });
    });

    it('derives resume eligibility from session capability and keeps execution-only and auxiliary Agents out of the catalog', () => {
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
        expect(executionOnlyAgent.catalogEntry).toBeNull();
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
                    probe: {
                        parser: 'none',
                        backgroundChecks: 'safe',
                    },
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

    it('projects only exact legacy-compatible Connected Service ids declared by an external Agent', () => {
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

        expect(contribution.catalogEntry?.connectedServiceIds).toEqual([
            'openai-codex',
        ]);
    });
});

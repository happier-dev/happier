import { describe, expect, it } from 'vitest';
import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
import { readAccountAgentProviderRequirements } from '@/providers/catalog/accountProviderDeclarations';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { projectVoiceSelectedAgentReadiness } from './projectVoiceAgentSelection';
import { EMPTY_MACHINE_AGENTS } from '@/agents/machineAgents/machineAgentInventoryStore';

describe('selected Voice Agent readiness', () => {
    it('uses initialized execution readiness only for the exact selected Machine and backend', () => {
        const target = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
        const activeRuntime = { serverId: 'home', machineId: 'machine',
            backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' }, ready: true };
        const context = { serverId: 'home', machineId: 'machine', activeRuntime };
        expect(projectVoiceSelectedAgentReadiness(target, EMPTY_MACHINE_AGENTS, context).runtime).toBe('ready');
        for (const mismatched of [
            { ...context, serverId: 'other-home' },
            { ...context, machineId: 'other-machine' },
            { ...context, activeRuntime: { ...activeRuntime, ready: false } },
            { ...context, activeRuntime: { ...activeRuntime, backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' } } },
        ]) expect(projectVoiceSelectedAgentReadiness(target, EMPTY_MACHINE_AGENTS, mismatched).runtime).toBe('unknown');
    });
    it('keeps an in-flight inventory probe pending until it settles without a usable Agent', () => {
        const target = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
        const context = { serverId: 'home', machineId: 'machine' };
        expect(projectVoiceSelectedAgentReadiness(target, { ...EMPTY_MACHINE_AGENTS, status: 'loading' }, context).runtime).toBe('pending');
        expect(projectVoiceSelectedAgentReadiness(target, { ...EMPTY_MACHINE_AGENTS, status: 'ready' }, context).runtime).toBe('unavailable');
    });

    it('uses the selected Provider credential route while preserving installation and unresolved-route blockers', () => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const serviceId = readAccountAgentProviderRequirements(agentTargetKey, { kind: 'account' })!.authIsolation.suppressConnectedServiceIds[0]!;
        const agent = projectMachineAgent({ agentId: 'codex', title: 'Codex', checking: false, stale: false, job: null,
            connectedServices: [{ serviceId, title: 'OpenAI', connected: false, healthy: false, profileLabel: null, profiles: [] }],
            facts: { agentId: 'codex', title: 'Codex', installed: true, version: '1', latestVersion: '1',
                update: { supported: false, command: null }, signIn: { status: 'signedOut', loginSupport: 'login_terminal' },
                platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] } });
        const target = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
        const inventory = { status: 'ready' as const, agents: [agent], lastCheckedAt: null };
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'resource', teamId: 'team',
            displayName: { content: { t: 'plain', v: 'Shared models' }, recipientEnvelope: null },
            resourceRevision: 3, readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', sourcePresentation: null,
            providerModels: [{ descriptor: { id: 'muse-spark-1.3', name: 'Muse Spark 1.3' }, sourceRevision: 'source-1', availability: 'available',
                selection: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team', expectedResourceRevision: 3,
                    deliveryMode: 'brokered', agentTargetKey, modelId: 'muse-spark-1.3' }, application: { agentTargetKey,
                    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                    endpointTemplateId: 'responses', protocol: 'openai-responses' } }] });
        const context = { serverId: 'home', machineId: 'machine', modelRoute: {
            selection: resource.providerModels[0]!.selection, agentTargetKey, declarationContext: { kind: 'account' as const },
            teamCredentialResources: [resource], teamCredentialResourceStatusByKey: new Map([['team:resource', { kind: 'current' as const }]]),
            acceptedConnectedServiceIds: [serviceId],
        } };
        expect(projectVoiceSelectedAgentReadiness(target, inventory, context)).toMatchObject({ runtime: 'ready', selectedAgent: { needsSignIn: false } });
        expect(projectVoiceSelectedAgentReadiness(target, { ...inventory, agents: [{ ...agent, installed: false }] }, context).runtime).toBe('missing');
        expect(projectVoiceSelectedAgentReadiness(target, inventory, { ...context, modelRoute: {
            ...context.modelRoute, teamCredentialResourceStatusByKey: new Map(),
        } }).runtime).toBe('unavailable');
        // The initialized brokered Run already proved its admitted execution route.
        // An unobserved passive Team catalog cannot withdraw that runtime fact.
        expect(projectVoiceSelectedAgentReadiness(target, EMPTY_MACHINE_AGENTS, { ...context, modelRoute: {
            ...context.modelRoute, teamCredentialResourceStatusByKey: new Map(),
        }, activeRuntime: { serverId: 'home', machineId: 'machine',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, ready: true } }).runtime).toBe('ready');
        expect(projectVoiceSelectedAgentReadiness(target, inventory, { serverId: 'home', machineId: 'machine' }))
            .toMatchObject({ runtime: 'missing', selectedAgent: { needsSignIn: true } });
    });
});

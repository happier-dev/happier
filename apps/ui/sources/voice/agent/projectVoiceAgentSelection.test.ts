import { describe, expect, it } from 'vitest';
import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
import { readAccountAgentProviderRequirements } from '@/providers/catalog/accountProviderDeclarations';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { projectVoiceSelectedAgentReadiness } from './projectVoiceAgentSelection';

describe('selected Voice Agent readiness', () => {
    it('uses the selected Provider credential route while preserving installation and unknown-route blockers', () => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const serviceId = readAccountAgentProviderRequirements(agentTargetKey, { kind: 'account' })!.authIsolation.suppressConnectedServiceIds[0]!;
        const agent = projectMachineAgent({ agentId: 'codex', title: 'Codex', checking: false, stale: false, job: null,
            connectedServices: [{ serviceId, title: 'OpenAI', connected: false, healthy: false, profileLabel: null, profiles: [] }],
            facts: { agentId: 'codex', title: 'Codex', installed: true, version: '1', latestVersion: '1',
                update: { supported: false, command: null }, signIn: { status: 'signedOut', loginSupport: 'login_terminal' },
                platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] } });
        const target = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
        const inventory = { status: 'ready' as const, agents: [agent], lastCheckedAt: null };
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'resource', teamId: 'team', displayName: 'Shared models',
            resourceRevision: 1, readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', sourcePresentation: null,
            providerModels: [{ descriptor: { id: 'model', name: 'Model' }, sourceRevision: 'source-1', availability: 'available',
                selection: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team', expectedResourceRevision: 1,
                    deliveryMode: 'brokered', agentTargetKey, modelId: 'model' }, application: { agentTargetKey,
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
        } }).runtime).toBe('unknown');
        expect(projectVoiceSelectedAgentReadiness(target, inventory, { serverId: 'home', machineId: 'machine' }))
            .toMatchObject({ runtime: 'missing', selectedAgent: { needsSignIn: true } });
    });
});

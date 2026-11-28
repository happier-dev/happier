import { describe, expect, it } from 'vitest';
import type { AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import {
    AgentRuntimeDaemonSessionOpenRequestV1Schema,
    AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema,
    projectAgentRuntimeDaemonSessionOpenAttestationRequestV1,
    type AgentRuntimeDaemonSessionOpenAttestationRequestV1,
} from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { createNativeAgentRuntimeSessionPlanFixture as createNativeAgentRuntimeSessionPlan } from './nativeAgentSession.composed.testkit';
import { createNativeSessionClientTestPort, createExternalContributionFixtures, createLease, createSessionHostServiceOwners } from './nativeAgentSession.composed.testkit';

describe('native Agent Session skill delivery', () => {
    it.each(['create', 'resume', 'fork'] as const)('delivers the host-owned folder through the %s open request', async kind => {
        const agentId = 'acme-skills-reader';
        const contributions = createExternalContributionFixtures(agentId, ['create', 'resume', 'fork']);
        const agent = { ...contributions.agent, richDefinition: {
            ...contributions.agent.richDefinition,
            definition: { ...contributions.agent.richDefinition.definition, capabilities: {
                ...contributions.agent.richDefinition.definition.capabilities,
                skills: { delivery: 'session_dir' as const, nativeDisable: 'unsupported' as const, liveReload: 'supported' as const },
            } },
        } };
        const requests: AgentSessionOpenRequest[] = [];
        const attestations: AgentRuntimeDaemonSessionOpenAttestationRequestV1[] = [];
        // The native Agent is the external process boundary; host construction stays real.
        const nativeSession: AgentSessionRuntime = {
            skillsDelivered: false,
            refreshSkills: async () => ({ kind: 'applied' }),
            send: async () => ({ status: 'admitted' }),
            watch: () => ({ dispose: () => undefined }), dispose: async () => undefined,
        };
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { open: async request => { requests.push(request); return nativeSession; } } },
            lease: createLease(agentId), backend: contributions.backend, agent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            attestSessionOpen: async ({ request }) => {
                // Consume the real builder's output at the same strict boundary as the runner bridge.
                const parsed = AgentRuntimeDaemonSessionOpenRequestV1Schema.parse(request);
                expect(parsed.skills).toEqual(request.skills);
                expect(parsed.mcpServers).toEqual(request.mcpServers);
                expect(parsed.mcpToolPolicy).toEqual(request.mcpToolPolicy);
                attestations.push(AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema.parse(
                    projectAgentRuntimeDaemonSessionOpenAttestationRequestV1(request),
                ));
            },
            sessionInput: buildPluginSessionBindingInput({
                credentials: { token: 'test-token', encryption: null },
                directory: '/tmp/skills-reader', backendTarget: { kind: 'backend', backendId: agentId },
                ...(kind === 'resume' ? { resume: 'vendor-session' } : {}),
                ...(kind === 'fork' ? { nativeForkSource: {
                    sessionId: 'source-session', providerSessionId: 'vendor-source', cwd: '/tmp/skills-reader',
                } } : {}),
            }),
        });
        const skills = { pluginRoot: '/skills/skills-reader', skillsRoot: '/skills/skills-reader/skills',
            items: [{ name: 'review', skillId: 'library-review', digest: 'sha256:review', directory: '/skills/skills-reader/skills/review' }], nativeDisables: [] };
        const mcpServers = { docs: { command: '/tools/docs', enabledTools: ['read'] } };
        const mcpToolPolicy = { docs: { unlisted: 'ask', tools: { read: 'allow', write: 'off' } } } as const;
        if (!plan.config.createSessionRuntime) throw new Error('Missing native Session factory');
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/skills-reader', metadata: {}, machineId: 'machine-1',
            session: createNativeSessionClientTestPort('skills-reader'),
            transcriptSession: {}, messageBuffer: {}, mcpServers, mcpToolPolicy, skills,
            permissionHandler: { cancelByPluginTurn: async () => undefined },
            getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false,
        } as never);
        try {
            expect(requests[0]?.kind).toBe(kind);
            expect(requests[0]?.skills).toEqual(skills);
            expect(attestations.map(attestation => attestation.kind)).toEqual([kind, kind]);
            for (const attestation of attestations) {
                expect(attestation).not.toHaveProperty('skills');
                expect(attestation.sessionId).toBe('skills-reader');
                expect(attestation.mcpServers).toEqual(mcpServers);
                expect(attestation.mcpToolPolicy).toEqual(mcpToolPolicy);
            }
            expect(created.skillsDelivered).toBe(false);
            expect(await created.nativeRuntime?.refreshSkills?.({ skills })).toEqual({ kind: 'applied' });
        } finally { await created.operations.resetOrDisposeRuntime(); }
    });
});

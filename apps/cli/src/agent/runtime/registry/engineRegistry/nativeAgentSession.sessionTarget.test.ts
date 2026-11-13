import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { resolveSessionHostCwd, SESSION_TARGET_PLACEMENT_ENV_KEY } from '@/subprocess/supervision/sessionTargetRelay';
import { createExternalContributionFixtures, createLease, createNativeAgentRuntimeSessionPlanFixture,
    createNativeSessionClientTestPort, createSessionHostServiceOwners } from './nativeAgentSession.testkit';

/**
 * A Session the daemon placed in a target (container/sandbox, no daemon inside):
 * the Agent runs there, so the workspace it is told about (protocol cwd,
 * `workspaceRoot`, ACP `session/new { cwd }`) is the workspace's path in the
 * target, chosen once at admission, never this Machine's Session path.
 */
afterEach(() => { delete sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY]; });

async function openAgentSession(directory: string, skills?: unknown) {
    const agentId = 'acme-placed';
    const contributions = createExternalContributionFixtures(agentId);
    const requests: AgentSessionOpenRequest[] = [];
    // The native Agent is the external process boundary; host construction stays real.
    const nativeSession: AgentSessionRuntime = {
        send: async () => ({ status: 'admitted' }), watch: () => ({ dispose: () => undefined }), dispose: async () => undefined,
    };
    const plan = await createNativeAgentRuntimeSessionPlanFixture({
        runtime: { sessions: { open: async request => { requests.push(request); return nativeSession; } } },
        lease: createLease(agentId), backend: contributions.backend, agent: contributions.agent,
        createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        sessionInput: buildPluginSessionBindingInput({ credentials: { token: 'test-token', encryption: null },
            directory, backendTarget: { kind: 'backend', backendId: agentId } }),
    });
    if (!plan.config.createSessionRuntime) throw new Error('Missing native Session factory');
    const created = await plan.config.createSessionRuntime({
        directory, metadata: {}, machineId: 'machine-1', session: createNativeSessionClientTestPort('placed-session'),
        transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: { cancelByPluginTurn: async () => undefined },
        getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false,
        ...(skills ? { skills } : {}),
    } as never);
    return { requests, created };
}

function place(workspace: Readonly<{ hostRoot: string; targetRoot: string }>) {
    sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({ id: 'managed:row-1', holderPath: '/root/.happier/holder/v/happier-session-holder',
        socketDirectory: '/root/.happier/holder/run', relaySocketPath: '/run/relay.sock', launch: { executables: {}, env: {}, workspace } });
}

describe('native Agent Session placed in a target', () => {
    it('tells the Agent the workspace path inside the target', async () => {
        place({ hostRoot: '/tmp/p03-cmuse', targetRoot: '/workspace' });
        const { requests, created } = await openAgentSession('/tmp/p03-cmuse');
        try {
            expect(requests.map(request => request.cwd)).toEqual(['/workspace']);
        } finally { await created.operations.resetOrDisposeRuntime(); }
    });

    it('passes skills by their target paths, and withholds a delivery whose folders are not in the target', async () => {
        place({ hostRoot: '/tmp/p03-cmuse', targetRoot: '/workspace' });
        const inside = { pluginRoot: '/tmp/p03-cmuse/.happier/skills-plugin', skillsRoot: '/tmp/p03-cmuse/.happier/skills-plugin/skills',
            items: [{ name: 'lint', skillId: 's1', digest: 'd', directory: '/tmp/p03-cmuse/.happier/skills-plugin/skills/lint' }],
            nativeDisables: [{ name: 'review', path: '/tmp/p03-cmuse/.claude/skills/review/SKILL.md' }] };
        const mapped = await openAgentSession('/tmp/p03-cmuse', inside);
        try {
            expect(mapped.requests.map(request => request.skills)).toEqual([{ pluginRoot: '/workspace/.happier/skills-plugin',
                skillsRoot: '/workspace/.happier/skills-plugin/skills',
                items: [{ name: 'lint', skillId: 's1', digest: 'd', directory: '/workspace/.happier/skills-plugin/skills/lint' }],
                nativeDisables: [{ name: 'review', path: '/workspace/.claude/skills/review/SKILL.md' }] }]);
        } finally { await mapped.created.operations.resetOrDisposeRuntime(); }
        const hostOnly = await openAgentSession('/tmp/p03-cmuse', { ...inside, pluginRoot: '/home/me/.happier/skills/s', skillsRoot: '/home/me/.happier/skills/s/skills' });
        try {
            expect(hostOnly.requests.map(request => request.skills)).toEqual([undefined]);
        } finally { await hostOnly.created.operations.resetOrDisposeRuntime(); }
    });

    it('keeps this Machine\'s path for a local Session', async () => {
        const { requests, created } = await openAgentSession('/tmp/local-session');
        try {
            expect(requests.map(request => request.cwd)).toEqual(['/tmp/local-session']);
        } finally { await created.operations.resetOrDisposeRuntime(); }
    });

    it('admits the Agent\'s target working directory on this Machine as its Session path (the holder maps it back)', () => {
        place({ hostRoot: '/tmp/p03-cmuse', targetRoot: '/workspace' });
        expect(['/workspace', '/workspace/sub', '/usr/bin', '/tmp/p03-cmuse/sub'].map(resolveSessionHostCwd))
            .toEqual(['/tmp/p03-cmuse', '/tmp/p03-cmuse/sub', '/usr/bin', '/tmp/p03-cmuse/sub']);
    });
});

import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { projectCurrentAgentSessionView } from '@happier-dev/agents';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { resolveAgentDisplayTitle } from '@/agent/catalog/agentDisplayTitle';
import { awaitTrackedRunnerAgentSessionOpen } from '@/daemon/agentRuntime/runnerAgentSessionOpenAttestation';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { TrackedSession } from '@/daemon/types';
import { attemptNativeForkOpen } from './attemptNativeForkOpen';
import type { ForkBackendResolution, ForkSpawnSession } from './forkLifecycleTypes';

const boundary = vi.hoisted(() => ({ create: vi.fn() }));
// The Session socket is a network boundary; fork recovery and observation stay real.
vi.mock('@/api/session/sockets', () => ({
    createSessionScopedSocket: boundary.create,
    createSessionScopedSocketConnection: () => {
        const socket = boundary.create();
        return { socket, transport: createSocketTransportAdapter(socket) };
    },
}));
afterEach(() => vi.restoreAllMocks());

it.each(['preflight', 'native'] as const)('retains the member-runnable Agent refusal from %s native-fork launch', async phase => {
    boundary.create.mockImplementation(() => Object.assign(new EventEmitter(), {
        connected: false, connect() {}, disconnect() {}, close() {},
    }));
    const childSessionId = 'c' + 'f'.repeat(24);
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session:
        createSessionRecordFixture({ id: childSessionId, active: false, encryptionMode: 'plain', metadata: '{}' }) } });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { success: true, archivedAt: 123 } });
    const descriptor = { v: 1 as const, agentId: 'codex', agent: { providerSessionId: 'provider-parent' } };
    const parentMetadata = projectCurrentAgentSessionView({ runtimeDescriptorV1: descriptor }, {
        agentId: 'codex', runtimeDescriptor: descriptor,
        nativeResumeIdentity: { v: 1, vendorResumeId: 'provider-parent' },
    });
    const backend = { ok: true, catalogAgentId: 'codex', agentHintAgentId: 'codex',
        backendTargetV2: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, replayFlavor: 'codex', metadataOverlay: {},
    } satisfies ForkBackendResolution;
    // Daemon process launch and child exit are the OS boundary. Classification
    // and the retained-runner observer are the same owners used by ordinary launch.
    const childProcess = new ChildProcess();
    Object.defineProperty(childProcess, 'exitCode', { value: 1 });
    const tracked: TrackedSession = { pid: 123, startedBy: 'daemon', happySessionId: childSessionId,
        processStartTimeMs: 100, processCommandHash: 'a'.repeat(64), childProcess };
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex',
        error: { code: 'agent_cli_not_runnable', message: 'PRIVATE_RUNTIME' }, occurredAt: 101 });
    const spawnSession = vi.fn<ForkSpawnSession>(async () => phase === 'preflight'
        ? { type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED', errorMessage: 'agent_cli_not_runnable', agentId: 'codex' }
        : { type: 'success', sessionId: childSessionId });
    const stopSession = vi.fn(async () => true);
    const result = await attemptNativeForkOpen({ credentials: { token: 'token', encryption: null },
        parentSessionId: 'parent', parentMetadata, directory: '/repo', forkPoint: { type: 'latest' },
        targetSeqInclusive: 9, effectiveCutoffSeqInclusive: 9, spawnNonce: 'member-fork',
        forkBackendResolution: backend, inheritedForkOverrides: { spawn: {}, metadata: {} }, spawnSession, stopSession,
        awaitAgentSessionOpen: params => awaitTrackedRunnerAgentSessionOpen({ ...params,
            getTrackedSessions: () => [tracked], readStartupFailure: async () => issue }),
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'agent_cli_not_runnable' });
    if (!result || result.ok) throw new Error('Expected typed fork refusal');
    expect(result.errorMessage).toContain(resolveAgentDisplayTitle('codex'));
    expect(result.errorMessage).toMatch(/install.*managed runtime/iu);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledTimes(phase === 'native' ? 1 : 0);
});

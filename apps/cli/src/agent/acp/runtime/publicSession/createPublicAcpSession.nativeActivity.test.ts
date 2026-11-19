import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { HostSessionApprovalRequest, HostSessionApprovalResult, HostSessionConfirmationRequest, HostSessionConfirmationResult, HostSessionQuestionsRequest, HostSessionQuestionsResult, HostSessionInteractionRequest, HostSessionInteractionResult } from '@/agent/runtime/state/currentSessionUiTypes';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createNativeAgentSessionWorkStateService } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionWorkState';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { readSessionWorkStateV1FromMetadata } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

// The current-session interaction service crosses into the host UI; keep ACP handling real.
function approve(request: HostSessionApprovalRequest): Promise<HostSessionApprovalResult>;
function approve(request: HostSessionQuestionsRequest): Promise<HostSessionQuestionsResult>;
function approve(request: HostSessionConfirmationRequest): Promise<HostSessionConfirmationResult>;
async function approve(request: HostSessionInteractionRequest): Promise<HostSessionInteractionResult> {
  if (request.kind !== 'approval') throw new Error('Unexpected interaction');
  return { requestId: 'native-approval', kind: 'approval', status: 'approved' };
}

describe('public ACP native requests', () => {
  it('publishes a Session plan and clears it through the canonical work-state publisher', async () => {
    await withTempDir('happier-acp-work-state-', async dir => {
      const session = createMutableApiSessionClientFixture({ sessionId: 'host-session' });
      const script = writeAcpTestAgentScript({ dir, fileName: 'plan.mjs', source: `
        import { createInterface } from 'node:readline';
        const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
        let prompts = 0;
        for await (const line of createInterface({ input: process.stdin })) {
          const message = JSON.parse(line);
          if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
          if (message.method === 'session/new') send({ id: message.id, result: { sessionId: 'native-session' } });
          if (message.method === 'session/prompt') {
            const entries = prompts++ === 0 ? [{ content: 'Check output', priority: 'high', status: 'in_progress' }] : [];
            send({ method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'plan', entries } } });
            send({ id: message.id, result: { stopReason: 'end_turn' } });
          }
        }
      ` });
      const planWorkState = createNativeAgentSessionWorkStateService({ session, pluginId: 'fixture',
        contributionId: 'fixture', agentId: 'fixture', occurrenceId: 'host-session',
        declarations: [{ id: 'acp-plan', itemKinds: ['todo'] }], isCurrent: () => true }).publisher('acp-plan');
      const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'host-session', cwd: dir }, {
        transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } },
      }, {
        ...{ planWorkState },
        pluginId: 'fixture', agentId: 'fixture', signal: new AbortController().signal, isCurrent: () => true,
        systemTools: { resolve: async () => ({ toolId: 'fixture', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
        interactions: { request: approve },
        media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
        models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
      });
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = runtime.watch(event => { events.push(event); });
      const prompt = async (turnId: string) => {
        await runtime.send({ inputIds: [turnId], input: { text: turnId }, delivery: { kind: 'newTurn', turnId },
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } });
        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: 'turn-complete', turnId })));
        return readSessionWorkStateV1FromMetadata(session.getMetadataSnapshot());
      };
      try {
        expect((await prompt('first'))?.items).toEqual([
          expect.objectContaining({ kind: 'todo', origin: 'vendor', status: 'active', title: 'Check output' }),
        ]);
        expect((await prompt('second'))?.items).toEqual([]);
      } finally {
        subscription.dispose();
        await runtime.dispose();
        await session.close();
      }
    });
  });

  it.each([
    { includeRequests: false, sessionScopedPermissions: false },
    { includeRequests: true, sessionScopedPermissions: false },
    { includeRequests: true, sessionScopedPermissions: true },
  ])('handles native requests without publishing diagnostic-only receipt events ($includeRequests, session permissions: $sessionScopedPermissions)', async ({ includeRequests, sessionScopedPermissions }) => {
    await withTempDir('happier-acp-native-activity-', async dir => {
      await writeFile(join(dir, 'native.txt'), 'native content');
      const script = writeAcpTestAgentScript({ dir, fileName: 'activity.mjs', source: `
        import { createInterface } from 'node:readline';
        let promptId;
        const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
        for await (const line of createInterface({ input: process.stdin })) {
          const message = JSON.parse(line);
          if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
          else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'native-session' } });
          else if (message.method === 'session/prompt') {
            promptId = message.id;
            for (const sessionId of ${JSON.stringify(includeRequests ? ['foreign-session', 'native-session'] : ['foreign-session'])}) send({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } },
            }});
            ${includeRequests
              ? "send({ jsonrpc: '2.0', id: 'native-read', method: 'fs/read_text_file', params: { sessionId: 'native-session', path: 'native.txt' } });"
              : "send({ jsonrpc: '2.0', id: 'native-extension', method: 'acme/progress', params: {} });"}
          } else if (message.id === 'native-read') {
            if (message.result?.content !== 'native content') throw new Error('Native filesystem read failed');
            send({ jsonrpc: '2.0', id: 'native-permission', method: 'session/request_permission', params: {
              sessionId: 'native-session', toolCall: { toolCallId: 'tool', kind: 'read', rawInput: { path: 'native.txt' } },
              options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
            }});
          } else if (message.id === 'native-permission') {
            send({ jsonrpc: '2.0', id: 'native-extension', method: 'acme/progress', params: {} });
          } else if (message.id === 'native-extension') {
            send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
          } else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
        }
      ` });
      let release!: () => void;
      const extensionGate = new Promise<void>(resolve => { release = resolve; });
      let extensionEntered!: () => void;
      const extensionStarted = new Promise<void>(resolve => { extensionEntered = resolve; });
      const dependencies: PublicAcpComposerDependencies = {
        pluginId: 'fixture', agentId: 'fixture', signal: new AbortController().signal, isCurrent: () => true,
        systemTools: { resolve: async () => ({ toolId: 'fixture', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
        interactions: { request: approve },
        media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
        models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
      };
      const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'host-session', cwd: dir }, {
        transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } },
        ...(sessionScopedPermissions ? { definition: { mcp: { policy: 'drop' as const }, permissions: { scope: 'session' as const } } } : {}),
        extensions: { requests: { 'acme/progress': async () => {
          extensionEntered();
          await extensionGate;
          return {};
        } } },
      }, dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = runtime.watch(event => { events.push(event); });
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      try {
        const sending = runtime.send({ inputIds: ['input'], input: { text: 'native events' }, delivery: { kind: 'newTurn', turnId: 'turn' }, causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' } });
        await extensionStarted;
        nowSpy.mockReturnValue(2_000);
        release();
        await sending;
        await vi.waitFor(() => expect(events.map(event => event.kind)).toContain('turn-complete'));
        expect(events.map(event => event.kind)).toContain('turn-start');
      } finally {
        release();
        subscription.dispose();
        await runtime.dispose();
        nowSpy.mockRestore();
      }
    });
  });
});

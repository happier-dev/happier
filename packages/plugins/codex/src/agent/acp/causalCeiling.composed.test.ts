import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { SessionInputCausalPermissionAuthorityV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import { createPublicAcpSession, type PublicAcpComposerDependencies } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { createNativeAgentSessionInteractionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { withTempDir } from '@/testkit/fs/tempDir';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { buildCodexNativeAcpRuntimeOptions } from './backend';

it('does not deliver a later read-only-ceiling message to a yolo Codex ACP process without approvals', async () => {
  await withTempDir('codex-acp-causal-ceiling-', async directory => {
    const capturePath = join(directory, 'turns.json');
    // Replace only the vendor executable at the managed-dependency boundary.
    // Native ACP, Codex launch policy, host runtime, queue and permission owner stay real.
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'codex-acp.mjs', source: `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { createInterface } from 'node:readline';
      const path = ${JSON.stringify(capturePath)};
      const captures = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
      const current = { args: process.argv.slice(2), prompts: [] };
      captures.push(current);
      const persist = () => writeFileSync(path, JSON.stringify(captures));
      persist();
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        if (request.id === undefined) continue;
        let result = {};
        if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} };
        if (request.method === 'session/new') result = { sessionId: 'codex-causal-native' };
        if (request.method === 'session/prompt') {
          current.prompts.push(request.params.prompt.filter(block => block.type === 'text').map(block => block.text).join(''));
          persist();
          result = { stopReason: 'end_turn' };
        }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      }
    ` });
    const configuration = { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
      permissionIntent: { value: 'yolo', updatedAtMs: 0 }, nativeSandbox: 'off', options: {} } as const;
    const dependencies: PublicAcpComposerDependencies = {
      pluginId: 'happier.agent.codex', agentId: 'codex', signal: new AbortController().signal, isCurrent: () => true,
      systemTools: { async resolve() { throw new Error('Unexpected system tool'); } },
      managedDependencies: { async resolve() { return { command: process.execPath, args: [script], release() {} }; } },
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    };
    const native = await createPublicAcpSession({ kind: 'create', sessionId: 'causal-session', cwd: directory, configuration },
      buildCodexNativeAcpRuntimeOptions({ kind: 'create', sessionId: 'causal-session', cwd: directory, configuration }), dependencies);
    // The Home transport reports the persisted input admitted; dispatch preparation stays real.
    const session = createMutableApiSessionClientFixture({ sessionId: 'causal-session', overrides: {
      async reconcileSessionInputForProviderDispatch() { return 'admitted'; },
    } });
    session.__setMetadata(createTestMetadata({ permissionMode: 'yolo', permissionModeUpdatedAt: 0 }));
    const settlements = vi.spyOn(session, 'observeProviderInputSettlement');
    const runtime = createNativeAgentSessionInteractionOperations({
      session: native, sessionId: session.sessionId, cwd: directory,
      context: { agent: { id: 'codex' } } as AgentSessionRuntimeContext,
      capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true, configuration: true },
      initialConfiguration: configuration,
    });
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(JSON.stringify,
      { batcher: combinePermissionModeQueuedPrompts });
    const writableAuthority = SessionInputCausalPermissionAuthorityV1Schema.parse({
      kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo',
    });
    queue.pushIsolate({ text: 'FIRST_YOLO_TURN', localId: 'first', causalPermissionAuthority: writableAuthority }, {
      permissionMode: 'yolo', causalPermissionAuthority: writableAuthority,
    });
    let ready = 0;
    try {
      await runPermissionModePromptLoop({
        providerName: 'Codex', agentMessageType: 'codex', explicitPermissionMode: undefined,
        session, messageQueue: queue, runtime,
        permissionHandler: createProviderEnforcedPermissionHandler({ session, logPrefix: '[ACP causal ceiling]' }),
        messageBuffer: new MessageBuffer(),
        createOverrideSynchronizer: () => ({ syncFromMetadata() {}, async flushPendingAfterStart() {} }),
        shouldExit: () => ready === 2, getAbortSignal: () => dependencies.signal,
        keepAlive() {}, setThinking() {}, sendReady() {
          ready += 1;
          if (ready === 1) {
            const causalPermissionAuthority = SessionInputCausalPermissionAuthorityV1Schema.parse({
              kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only',
            });
            queue.pushIsolate({ text: 'LATER_READ_ONLY_CEILING', localId: 'lower', causalPermissionAuthority }, {
              permissionMode: 'yolo', causalPermissionAuthority,
            });
          }
        },
        currentPermissionModeUpdatedAt: 0, setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {},
        registerProviderAcceptedEffect: () => undefined, formatPromptErrorMessage: String,
      });
      const captures = JSON.parse(readFileSync(capturePath, 'utf8')) as { args: string[]; prompts: string[] }[];
      expect(captures[0].args).toContain('approval_policy="never"');
      expect(captures[0].prompts.some(prompt => prompt.includes('FIRST_YOLO_TURN'))).toBe(true);
      const lowerTurns = captures.filter(capture => capture.prompts.some(prompt => prompt.includes('LATER_READ_ONLY_CEILING')));
      if (lowerTurns.length > 0) {
        for (const turn of lowerTurns) expect(turn.args).toContain('approval_policy="untrusted"');
      } else {
        expect(settlements).toHaveBeenCalledWith(expect.objectContaining({ localId: 'lower', kind: 'rejected_before_effect',
          diagnostic: expect.objectContaining({ code: 'permission_mode_not_granted' }) }));
      }
    } finally { await native.dispose(); }
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { SessionInputCausalPermissionAuthorityV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import { createPublicAcpSession, type PublicAcpComposerDependencies } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { createNativeAgentSessionInteractionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createExternalContributionFixtures } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';
import { createNativeAgentHostSessionRuntimePlan } from '@/plugins/runtime/runtimeCore/plugin/session';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { withTempDir } from '@/testkit/fs/tempDir';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { buildCodexNativeAcpRuntimeOptions } from './backend';

it.each([
  { initialMode: 'default', cold: false, configurationSupported: true },
  { initialMode: 'yolo', cold: false, configurationSupported: true },
  { initialMode: 'yolo', cold: true, configurationSupported: true },
  { initialMode: 'default', cold: false, configurationSupported: false },
] as const)('enforces an admitted read-only ceiling ($initialMode, cold=$cold, configuration=$configurationSupported)', async ({ initialMode, cold, configurationSupported }) => {
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
        if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
        if (request.method === 'session/new' || request.method === 'session/load') result = { sessionId: 'codex-causal-native' };
        if (request.method === 'session/prompt') {
          current.prompts.push(request.params.prompt.filter(block => block.type === 'text').map(block => block.text).join(''));
          persist();
          result = { stopReason: 'end_turn' };
        }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      }
    ` });
    const configuration = { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
      permissionIntent: { value: initialMode, updatedAtMs: 0 }, nativeSandbox: 'off', options: {} } as const;
    const dependencies: PublicAcpComposerDependencies = {
      pluginId: 'happier.agent.codex', agentId: 'codex', signal: new AbortController().signal, isCurrent: () => true,
      systemTools: { async resolve() { throw new Error('Unexpected system tool'); } },
      managedDependencies: { async resolve() { return { command: process.execPath, args: [script], release() {} }; } },
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    };
    // The Home transport reports the persisted input admitted; dispatch preparation stays real.
    const session = createMutableApiSessionClientFixture({ sessionId: 'causal-session', overrides: {
      async reconcileSessionInputForProviderDispatch() { return 'admitted'; },
    } });
    session.__setMetadata(createTestMetadata({ permissionMode: initialMode, permissionModeUpdatedAt: 0 }));
    const settlements = vi.spyOn(session, 'observeProviderInputSettlement');
    const permissionHandler = createProviderEnforcedPermissionHandler({ session, logPrefix: '[ACP causal ceiling]' });
    permissionHandler.setPermissionMode(initialMode);
    const contributions = createExternalContributionFixtures('codex-causal');
    const plan = await createNativeAgentHostSessionRuntimePlan({
      ...contributions, policyAgentId: 'codex',
      sessionInput: buildPluginSessionBindingInput({
        credentials: { token: 'fixture', encryption: { type: 'legacy', secret: new Uint8Array(32) } }, directory,
      }),
      async createSessionRuntime(intent, host) {
        const nextConfiguration = { ...configuration,
          permissionIntent: { value: parseAgentPermissionIntentV1Alias(host.getPermissionMode()) ?? 'default', updatedAtMs: 0 } };
        const request = { ...intent, sessionId: session.sessionId, cwd: directory, configuration: nextConfiguration };
        const native = await createPublicAcpSession(request, buildCodexNativeAcpRuntimeOptions(request), dependencies);
        return createNativeAgentSessionInteractionOperations({
          session: native, sessionId: session.sessionId, cwd: directory,
          context: { agent: { id: 'codex' } } as AgentSessionRuntimeContext,
          capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true, configuration: configurationSupported },
          initialConfiguration: nextConfiguration,
        });
      },
    });
    if (!plan.config.createSessionRuntime) throw new Error('Missing runtime factory');
    const created = await plan.config.createSessionRuntime({
      directory, metadata: session.getMetadataSnapshot(), machineId: 'machine', session, transcriptSession: session,
      messageBuffer: {}, mcpServers: {}, permissionHandler, getPermissionMode: () => permissionHandler.getPermissionMode(),
      setThinking() {}, memoryRecallGuidanceEnabled: false,
    } as never);
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(JSON.stringify,
      { batcher: combinePermissionModeQueuedPrompts });
    const writableAuthority = SessionInputCausalPermissionAuthorityV1Schema.parse({
      kind: 'admittedSessionInputV1', admittedPermissionCeiling: initialMode,
    });
    const enqueueLower = () => {
      const causalPermissionAuthority = SessionInputCausalPermissionAuthorityV1Schema.parse({
        kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only',
      });
      queue.pushIsolate({ text: 'LATER_READ_ONLY_CEILING', localId: 'lower', causalPermissionAuthority }, {
        permissionMode: initialMode, causalPermissionAuthority,
      });
    };
    if (cold) enqueueLower();
    else queue.pushIsolate({ text: 'FIRST_WRITABLE_TURN', localId: 'first',
      ...(configurationSupported ? { causalPermissionAuthority: writableAuthority } : {}) }, {
      permissionMode: initialMode, ...(configurationSupported ? { causalPermissionAuthority: writableAuthority } : {}),
    });
    let ready = 0;
    try {
      await runPermissionModePromptLoop({
        providerName: 'Codex', agentMessageType: 'codex', explicitPermissionMode: undefined,
        session, messageQueue: queue, runtime: created.operations,
        permissionHandler,
        messageBuffer: new MessageBuffer(),
        createOverrideSynchronizer: () => ({ syncFromMetadata() {}, async flushPendingAfterStart() {} }),
        shouldExit: () => ready === (cold ? 1 : 2), getAbortSignal: () => dependencies.signal,
        keepAlive() {}, setThinking() {}, sendReady() {
          ready += 1;
          if (!cold && ready === 1) enqueueLower();
        },
        currentPermissionModeUpdatedAt: 0, setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {},
        registerProviderAcceptedEffect: () => undefined, formatPromptErrorMessage: String,
      });
      const captures = JSON.parse(readFileSync(capturePath, 'utf8')) as { args: string[]; prompts: string[] }[];
      if (!cold) {
        expect(captures[0].args).toContain(`approval_policy="${initialMode === 'yolo' ? 'never' : 'untrusted'}"`);
        expect(captures[0].prompts.some(prompt => prompt.includes('FIRST_WRITABLE_TURN'))).toBe(true);
      }
      const lowerTurns = captures.filter(capture => capture.prompts.some(prompt => prompt.includes('LATER_READ_ONLY_CEILING')));
      if (configurationSupported) {
        expect(lowerTurns).toHaveLength(1);
        expect(lowerTurns[0].args).toContain('approval_policy="untrusted"');
        expect(settlements).not.toHaveBeenCalledWith(expect.objectContaining({ localId: 'lower', kind: 'rejected_before_effect' }));
      } else {
        expect(lowerTurns).toHaveLength(0);
        expect(settlements).toHaveBeenCalledWith(expect.objectContaining({ localId: 'lower', kind: 'rejected_before_effect',
          reason: 'runtime_config_blocked', retryable: false,
          diagnostic: expect.objectContaining({ code: 'permission_mode_not_granted' }) }));
      }
    } finally { await created.operations.resetOrDisposeRuntime(); }
  });
});

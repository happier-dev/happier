import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

import { createNativeAgentSessionInteractionOperations } from '../registry/engineRegistry/nativeAgentSession';
import { createClaudeNativeRuntime, createClaudeNativeSessionRuntimeFromOperations } from '../../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import { createClaudeUnifiedTerminalTurnOperations } from '../../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/turnOperations';
import { createEventsFixture, createPluginContextFixture, createTerminalHostFixture } from '../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';

describe('Claude selected native manual compaction → generic host → native command', () => {
  it('binds the selected descriptor and injects one native command with instructions', async () => {
    const terminalHost = createTerminalHostFixture();
    // Terminal, transcript IO and host service registration are external boundaries.
    const ctx = createPluginContextFixture(terminalHost.service, createEventsFixture().service, {
      transcripts: {
        followSource: vi.fn(async () => ({ dispose: async () => undefined })),
        append: vi.fn(async () => undefined),
        defineSource: vi.fn(async ({ id }: { id: string }) => ({ id, dispose: async () => undefined })),
        fileFollow: { follow: vi.fn(async () => ({ id: 'native-manual', drainNow: async () => undefined, close: async () => undefined })) },
      },
    });
    const context = { agent: { id: 'claude' }, session: { id: 'manual-native', services: {
      activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) },
    } } } as unknown as AgentSessionRuntimeContext;
    const operations = createClaudeUnifiedTerminalTurnOperations({ ctx, directory: '/tmp/claude-manual',
      happierSessionId: 'manual-native', hostPreference: 'zellij', launchEnv: {}, permissionMode: 'default' });
    const session = createClaudeNativeSessionRuntimeFromOperations(operations,
      { kind: 'create', sessionId: 'manual-native', cwd: '/tmp/claude-manual' }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    const subscription = session.watch(event => events.push(event));
    try {
      const select = createClaudeNativeRuntime({ openSession: async () => { throw new Error('Selection must not open a Session'); } })
        .sessions?.resolveTerminalPresentation;
      if (!select) throw new Error('Claude selection is missing');
      const selected = await select({
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: { backendMode: 'unifiedTerminal' } },
      }, { features: { isEnabled: () => true }, settings: { forScope: () => ({ get: async () => false }) } } as unknown as Parameters<typeof select>[1]);
      const host = createNativeAgentSessionInteractionOperations({ session, sessionId: 'manual-native',
        cwd: '/tmp/claude-manual', context,
        capabilities: { open: ['create'], delivery: ['newTurn'], compaction: selected.compaction },
      });
      await operations.startProviderSession();
      const hook = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]?.[0].onSessionHook;
      if (!hook || !session.observeSourceTranscript) throw new Error('Native Session hooks are missing');
      await hook('native-manual', { hook_event_name: 'SessionStart', session_id: 'native-manual',
        source: 'resume', transcript_path: '/tmp/native-manual.jsonl' });
      expect(host.compactContext).toBeTypeOf('function');
      await host.compactContext!('/compact Keep current decisions');
      expect(vi.mocked(terminalHost.service.injectUserPrompt).mock.calls).toMatchObject([
        [expect.anything(), { text: '/compact Keep current decisions' }],
      ]);
      await session.observeSourceTranscript({ providerSessionId: 'native-manual', sourceId: 'manual:boundary', row: {
        type: 'system', subtype: 'compact_boundary', uuid: 'manual-boundary', sessionId: 'native-manual',
        compactMetadata: { trigger: 'manual' },
      } });
      expect(events.filter(event => event.kind === 'context-compaction')).toMatchObject([
        { phase: 'completed', trigger: 'manual', compactionId: expect.stringMatching(/^host-compact-/u) },
      ]);
    } finally { subscription.dispose(); await session.dispose(); }
  });
});

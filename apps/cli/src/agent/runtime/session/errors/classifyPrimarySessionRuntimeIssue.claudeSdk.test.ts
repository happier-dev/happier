import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

import {
  createEventsFixture,
  createPluginContextFixture,
  createSdkExecFixture,
  createTerminalHostFixture,
} from '../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import { classifyPrimarySessionRuntimeIssue } from './classifyPrimarySessionRuntimeIssue';

describe('Claude SDK quota failure through the primary runtime issue owner', () => {
  it.each([
    { entry: 'assistant', text: "You've hit your weekly limit · resets Nov 9, 4pm (Europe/Amsterdam)", resetAtMs: Date.parse('2026-11-09T15:00:00Z') },
    { entry: 'result', text: "You've hit your weekly limit · resets Nov 9, 4pm (Europe/Amsterdam)", resetAtMs: Date.parse('2026-11-09T15:00:00Z') },
    { entry: 'result', text: 'Usage limit reached · resets sometime (Unknown/Zone)', resetAtMs: null },
    { entry: 'result', text: 'Usage limit reached', resetAtMs: null },
  ] as const)('carries the $entry failure and honest reset for $text', async ({ entry, text, resetAtMs }) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-07T09:00:00Z'));
    const exec = createSdkExecFixture();
    const base = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, { exec: exec.service });
    // Native-home reads and the SDK process are genuine system boundaries. Keep
    // the request identity, event codecs, auth adapter and host classifier real.
    const ctx = { ...base, agentRuntime: { ...base.agentRuntime, nativeHome: {
      async readFiles() {
        return {
          '.claude.json': new TextEncoder().encode(JSON.stringify({ oauthAccount: { accountUuid: 'issued-account' } })),
          '.happier-claude-connected-service-home.json': new TextEncoder().encode(JSON.stringify({
            v: 1, serviceId: 'claude-subscription', credentialProfileId: 'issued-profile', credentialCreatedAt: 1,
            groupId: 'issued-pool', generation: 4, credentialRevision: 'csr_abcdefghijklmnopqrstuv',
          })),
        };
      },
    } } };
    const launchEnv = { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
      kind: 'group', serviceId: 'claude-subscription', groupId: 'issued-pool', activeProfileId: 'issued-profile',
      fallbackProfileId: 'issued-profile', generation: 4, credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    }]) };
    const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: '/tmp/claude-quota-issue', launchEnv,
      happierSessionId: 'quota-session', permissionMode: 'default' });
    // The host's lifecycle ports are outside the native plugin under test.
    const context = { services: { exec: exec.service }, session: { services: {
      activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) },
    } } } as unknown as AgentSessionRuntimeContext;
    const native = createClaudeNativeSessionRuntimeFromOperations(operations, { kind: 'create', sessionId: 'quota-session',
      cwd: '/tmp/claude-quota-issue', launchEnvironment: { values: launchEnv, unset: [] } }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    native.watch(event => events.push(event));
    try {
      await native.send({ inputIds: ['quota-input'], input: { text: 'prompt' }, delivery: { kind: 'newTurn', turnId: 'quota-turn' } });
      await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledOnce());
      if (entry === 'assistant') {
        await exec.emit({ type: 'assistant', error: 'rate_limit',
          message: { role: 'assistant', content: [{ type: 'text', text }] } });
      }
      await exec.emit({ type: 'result', subtype: 'error_during_execution', is_error: true,
        session_id: 'native-quota', errors: [entry === 'assistant' ? 'Execution failed' : text] });
      await vi.waitFor(() => expect(events.some(event => event.kind === 'turn-failed')).toBe(true));
      const failure = events.find(event => event.kind === 'turn-failed');
      if (failure?.kind !== 'turn-failed') throw new Error('Missing native failure');
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'claude',
        occurredAt: Date.now(), error: failure.diagnostic });
      expect(issue).toMatchObject({ code: 'usage_limit', source: 'usage_limit', agentId: 'claude', usageLimit: {
        v: 1, resetAtMs, quotaScope: 'account', recoverability: 'switch_account',
        connectedService: { serviceId: 'happier.agent.claude/claude-subscription', profileId: 'issued-profile', groupId: 'issued-pool' },
      } });
    } finally {
      await native.dispose('session_closed');
      clock.mockRestore();
    }
  });
});

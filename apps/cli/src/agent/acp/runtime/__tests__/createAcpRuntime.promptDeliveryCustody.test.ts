import { describe, expect, it } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { makeAbortError } from '@/agent/acp/timeouts/acpBackendTimeouts';
import {
  AgentSessionRuntimeEventV1Schema,
  type AgentSessionRuntimeEventV1,
} from '@happier-dev/protocol';

import { createAcpRuntime } from '../createAcpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';

/**
 * Delivery confirmation — not turn completion — is what settles a dispatched prompt's
 * custody at this seam. The caller retires the replay activation seed the moment
 * `sendTurnPrompt` resolves, so an accepted-then-cancelled turn that rejects the send
 * leaves the seed live and re-prefixes the whole carry-over context onto the next message.
 */
describe('createAcpRuntime (prompt delivery custody)', () => {
  function createRuntimeUnderTest(
    backendOverrides: Parameters<typeof createFakeAcpRuntimeBackend>[0] = {},
  ) {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main', ...backendOverrides });
    const { session, committed } = createSessionClientWithMetadata();
    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });
    const events: AgentSessionRuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((message) => {
      events.push(AgentSessionRuntimeEventV1Schema.parse(message));
    });
    return { runtime, backend, committed, events };
  }

  const committedTypes = (committed: readonly unknown[]): string[] =>
    committed.map((body) => String((body as { type?: unknown }).type));

  it('settles the send after confirmed delivery even when the turn is then cancelled', async () => {
    const { runtime, committed } = createRuntimeUnderTest({
      waitForResponseComplete: async () => {
        throw makeAbortError('Cancelled by user');
      },
    });

    runtime.beginTurnLifecycle();

    await expect(runtime.sendTurnPrompt('seeded prompt')).resolves.toBeUndefined();

    await runtime.waitForTurnCompletion();
    expect(committedTypes(committed)).not.toContain('task_complete');
  });

  it('settles the send after confirmed delivery when the turn then fails, surfacing the failure once', async () => {
    const failure = new Error('provider transport died');
    const { runtime, committed, events } = createRuntimeUnderTest({
      waitForResponseComplete: async () => {
        throw failure;
      },
    });

    runtime.beginTurnLifecycle();

    await expect(runtime.sendTurnPrompt('seeded prompt')).resolves.toBeUndefined();

    await runtime.waitForTurnCompletion();
    expect(committedTypes(committed)).not.toContain('task_complete');
    expect(events.filter((event) => event.kind === 'turn-failed')).toHaveLength(1);
  });

  it('rejects the send when the provider may have received the prompt but did not confirm it', async () => {
    const ambiguous = new Error('transport write may have landed');
    const { runtime } = createRuntimeUnderTest({
      sendPrompt: async () => ({ kind: 'effect_may_have_occurred' as const, error: ambiguous }),
    });

    runtime.beginTurnLifecycle();

    await expect(runtime.sendTurnPrompt('seeded prompt')).rejects.toBe(ambiguous);
  });

  it('rejects the send when the provider rejected the prompt before any effect', async () => {
    const rejected = new Error('prompt rejected before effect');
    const { runtime } = createRuntimeUnderTest({
      sendPrompt: async () => ({ kind: 'rejected_before_effect' as const, error: rejected }),
    });

    runtime.beginTurnLifecycle();

    await expect(runtime.sendTurnPrompt('seeded prompt')).rejects.toBe(rejected);
  });

  it('rejects the send when the transport throws before any delivery evidence', async () => {
    const transportFailure = new Error('transport write failed');
    const { runtime } = createRuntimeUnderTest({
      sendPrompt: async () => {
        throw transportFailure;
      },
    });

    runtime.beginTurnLifecycle();

    await expect(runtime.sendTurnPrompt('seeded prompt')).rejects.toBe(transportFailure);
  });
});

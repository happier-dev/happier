import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import {
  combinePermissionModeQueuedPrompts,
  type PermissionModeQueuedPrompt,
} from '@/agent/runtime/permission/permissionModeQueuedPrompt';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { PermissionMode } from '@/api/types';

import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';

const SEED_TEXT = 'REPLAY SEED CARRY-OVER CONTEXT';

function createModeQueue() {
  return new MessageQueue2<
    { permissionMode: PermissionMode; appendSystemPrompt?: string | null },
    PermissionModeQueuedPrompt
  >((mode) => mode.permissionMode, {
    batcher: (messages) => combinePermissionModeQueuedPrompts(messages),
  });
}

function createSeededMetadata(): Record<string, any> {
  return {
    permissionMode: 'default',
    permissionModeUpdatedAt: 0,
    replaySeedV1: {
      v: 1,
      seedText: SEED_TEXT,
      sourceSessionId: 'source-session',
      sourceCutoffSeqInclusive: 12,
      createdAtMs: 1,
    },
  };
}

/**
 * Drives two queued prompts through the loop. The first send reports provider
 * acceptance through `sendPromptWithMeta`'s own callback and then fails the way an
 * aborted ACP turn does; the second send simply records the prompt it received.
 */
async function runTwoPromptsWithFirstTurnAborted(params: Readonly<{
  reportAcceptanceBeforeAbort: boolean;
}>): Promise<{
  seedAtEachSend: any[];
  providerPrompts: string[];
}> {
  const queue = createModeQueue();
  queue.push(
    { text: 'first user message', localId: 'local-1' },
    { permissionMode: 'default' },
    { userMessageLocalId: 'local-1' },
  );

  let metadata = createSeededMetadata();
  const providerPrompts: string[] = [];
  const seedAtEachSend: any[] = [];
  let sendCount = 0;

  const runtime = {
    beginTurn: vi.fn(),
    startOrLoad: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async () => undefined),
    sendPromptWithMeta: vi.fn(async (prompt: {
      text: string;
      onProviderPromptAccepted?: () => void;
    }) => {
      sendCount += 1;
      providerPrompts.push(prompt.text);
      seedAtEachSend.push({ ...metadata.replaySeedV1 });
      if (sendCount === 1) {
        if (params.reportAcceptanceBeforeAbort) {
          // The provider took custody of the prompt — the ACP submission evidence
          // seam publishes acceptance here, long before the turn resolves.
          prompt.onProviderPromptAccepted?.();
        }
        // …and the user then aborts the turn, so the prompt call itself rejects.
        const abort = new Error('Cancelled by user');
        abort.name = 'AbortError';
        throw abort;
      }
    }),
    failTurn: vi.fn(async () => true),
    flushTurn: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    getSessionId: vi.fn(() => 'test-session'),
  };

  let shouldExit = false;
  const session = {
    getMetadataSnapshot: () => metadata,
    updateMetadata: (updater: (current: typeof metadata) => typeof metadata) => {
      metadata = updater(metadata);
    },
    ensureMetadataSnapshot: async () => metadata,
    waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
    waitForPendingEligibilityUpdate: () => new Promise<void>(() => {}),
    fetchLatestUserPermissionIntentFromTranscript: async () => null,
    sendAgentMessage: vi.fn(),
  };

  await runPermissionModePromptLoop({
    providerName: 'Test ACP',
    agentMessageType: 'qwen',
    explicitPermissionMode: 'default',
    session: session as any,
    messageQueue: queue,
    permissionHandler: {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any,
    runtime,
    createOverrideSynchronizer: () => ({
      syncFromMetadata: () => {},
      flushPendingAfterStart: async () => {},
    }),
    messageBuffer: new MessageBuffer(),
    shouldExit: () => shouldExit,
    getAbortSignal: () => new AbortController().signal,
    keepAlive: () => {},
    setThinking: () => {},
    sendReady: () => {
      if (sendCount === 1) {
        // The user answers the aborted turn with the follow-up that reproduced the
        // incident.
        queue.push(
          { text: 'Continue', localId: 'local-2' },
          { permissionMode: 'default' },
          { userMessageLocalId: 'local-2' },
        );
        return;
      }
      shouldExit = true;
    },
    currentPermissionModeUpdatedAt: 0,
    setCurrentPermissionMode: () => {},
    setCurrentPermissionModeUpdatedAt: () => {},
    formatPromptErrorMessage: (error) => String(error),
  });

  return { seedAtEachSend, providerPrompts };
}

describe('runPermissionModePromptLoop replay seed retirement', () => {
  it('retires the seed on confirmed delivery even when the turn is then aborted', async () => {
    const { seedAtEachSend, providerPrompts } = await runTwoPromptsWithFirstTurnAborted({
      reportAcceptanceBeforeAbort: true,
    });

    expect(providerPrompts).toHaveLength(2);
    expect(providerPrompts[0]).toContain(SEED_TEXT);
    // The incident: the provider already holds the seed, so the next prompt must
    // not carry it again.
    expect(providerPrompts[1]).not.toContain(SEED_TEXT);
    expect(seedAtEachSend[1]).toMatchObject({
      seedText: '',
      appliedToLocalId: 'local-1',
    });
  });

  it('keeps the seed live when delivery was never confirmed', async () => {
    const { seedAtEachSend, providerPrompts } = await runTwoPromptsWithFirstTurnAborted({
      reportAcceptanceBeforeAbort: false,
    });

    expect(providerPrompts).toHaveLength(2);
    expect(providerPrompts[0]).toContain(SEED_TEXT);
    // Unconfirmed delivery keeps the documented safety margin: better twice than
    // never.
    expect(providerPrompts[1]).toContain(SEED_TEXT);
    expect(seedAtEachSend[1].seedText).toBe(SEED_TEXT);
    expect(seedAtEachSend[1].appliedToLocalId).toBeUndefined();
  });
});

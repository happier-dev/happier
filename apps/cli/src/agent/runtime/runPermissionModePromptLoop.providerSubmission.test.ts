import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import {
  combinePermissionModeQueuedPrompts,
  type PermissionModeQueuedPrompt,
} from '@/agent/runtime/permission/permissionModeQueuedPrompt';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { PermissionMode } from '@/api/types';

import { ProviderPromptSubmissionRejectedBeforeEffectError } from './providerPromptSubmission';
import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';

function createModeQueue() {
  return new MessageQueue2<
    { permissionMode: PermissionMode; appendSystemPrompt?: string | null },
    PermissionModeQueuedPrompt
  >((mode) => mode.permissionMode, {
    batcher: (messages) => combinePermissionModeQueuedPrompts(messages),
  });
}

describe('runPermissionModePromptLoop provider submission phase ownership', () => {
  it('delivers advertised provider commands unchanged and defers fresh-session prompt composition', async () => {
    const queue = createModeQueue();
    queue.push(
      { text: '/goal fix authentication', localId: 'local-command' },
      { permissionMode: 'default' },
      { userMessageLocalId: 'local-command' },
    );

    const metadata: Record<string, unknown> = {
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    };
    let shouldExit = false;
    const resolveFreshSessionSystemPrompt = vi.fn(async () => 'HAPPIER SYSTEM PROMPT');
    const sendPromptWithMeta = vi.fn(async (prompt: { onProviderPromptAccepted?: () => void }) => {
      prompt.onProviderPromptAccepted?.();
      shouldExit = true;
    });

    await runPermissionModePromptLoop({
      providerName: 'Pi',
      providerId: 'pi',
      agentMessageType: 'pi',
      explicitPermissionMode: 'default',
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: vi.fn(),
        ensureMetadataSnapshot: async () => metadata,
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        waitForPendingEligibilityUpdate: () => new Promise<void>(() => {}),
        fetchLatestUserPermissionIntentFromTranscript: async () => null,
        sendAgentMessage: vi.fn(),
      } as any,
      messageQueue: queue,
      permissionHandler: {
        setPermissionMode: vi.fn(),
        reset: vi.fn(),
      } as any,
      runtime: {
        beginTurn: vi.fn(),
        startOrLoad: vi.fn(async () => undefined),
        isProviderNativeCommand: vi.fn(async (text: string) => text.startsWith('/goal')),
        sendPrompt: vi.fn(async () => undefined),
        sendPromptWithMeta,
        flushTurn: vi.fn(async () => undefined),
        reset: vi.fn(async () => undefined),
        getSessionId: vi.fn(() => 'pi-session'),
      },
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => {},
        flushPendingAfterStart: async () => {},
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {},
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      resolveFreshSessionSystemPrompt,
      formatPromptErrorMessage: (error) => String(error),
    });

    expect(sendPromptWithMeta).toHaveBeenCalledWith(expect.objectContaining({
      text: '/goal fix authentication',
    }));
    expect(resolveFreshSessionSystemPrompt).not.toHaveBeenCalled();
  });

  it('attributes acceptance to the model captured before provider dispatch', async () => {
    const queue = createModeQueue();
    queue.push(
      { text: 'hello', localId: 'local-1' },
      { permissionMode: 'default' },
      { userMessageLocalId: 'local-1' },
    );

    let metadata: Record<string, any> = {
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
      sessionModelsV1: {
        v: 1,
        provider: 'qwen',
        updatedAt: 1,
        currentModelId: 'model-for-this-prompt',
        availableModels: [],
      },
    };
    const providerInputOutcomeObserver = vi.fn();
    const runtime = {
      beginTurn: vi.fn(),
      startOrLoad: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => undefined),
      sendPromptWithMeta: vi.fn(async (prompt: { onProviderPromptAccepted?: () => void }) => {
        metadata = {
          ...metadata,
          sessionModelsV1: {
            ...metadata.sessionModelsV1,
            updatedAt: 2,
            currentModelId: 'selected-after-dispatch',
          },
        };
        prompt.onProviderPromptAccepted?.();
      }),
      flushTurn: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
      getSessionId: vi.fn(() => 'test-session'),
    };
    let shouldExit = false;

    await runPermissionModePromptLoop({
      providerName: 'Test ACP',
      agentMessageType: 'qwen',
      explicitPermissionMode: 'default',
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: (updater: (current: typeof metadata) => typeof metadata) => {
          metadata = updater(metadata);
        },
        ensureMetadataSnapshot: async () => metadata,
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        waitForPendingEligibilityUpdate: () => new Promise<void>(() => {}),
        fetchLatestUserPermissionIntentFromTranscript: async () => null,
        sendAgentMessage: vi.fn(),
      } as any,
      providerInputOutcomeObserver,
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
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => String(error),
    });

    expect(providerInputOutcomeObserver).toHaveBeenCalledWith({
      kind: 'accepted',
      localId: 'local-1',
      appliedModelId: 'model-for-this-prompt',
    });
  });

  it.each([
    {
      title: 'proven pre-effect rejection',
      error: new ProviderPromptSubmissionRejectedBeforeEffectError(
        'runtime_disposed_before_delivery',
        new Error('ACP session not started'),
      ),
      expectedOutcome: {
        kind: 'rejected_before_effect',
        localId: 'local-1',
        reason: 'runtime_disposed_before_delivery',
      },
    },
    {
      title: 'proven provider-unavailable rejection before dispatch',
      error: new ProviderPromptSubmissionRejectedBeforeEffectError(
        'provider_unavailable_before_acceptance',
        new Error('OpenCode broker preflight failed before prompt_async'),
      ),
      expectedOutcome: {
        kind: 'rejected_before_effect',
        localId: 'local-1',
        reason: 'provider_unavailable_before_acceptance',
      },
    },
    {
      title: 'proven provider rejection before acceptance',
      error: new ProviderPromptSubmissionRejectedBeforeEffectError(
        'provider_rejected_before_acceptance',
        Object.assign(new Error('Pi provider rejected the prompt before acceptance without details'), {
          piProviderFailure: {
            classification: 'pi_provider_failure',
            code: 'pi_provider_session_error',
            sanitizedPreview: 'Pi provider rejected the prompt before acceptance without details',
          },
        }),
      ),
      expectedOutcome: {
        kind: 'rejected_before_effect',
        localId: 'local-1',
        reason: 'provider_rejected_before_acceptance',
      },
    },
    {
      title: 'effect-possible response loss',
      error: new Error('ACP prompt response was lost'),
      expectedOutcome: {
        kind: 'effect_may_have_occurred',
        localId: 'local-1',
      },
    },
  ] as const)('reports $title through the host outcome normalizer', async ({ error, expectedOutcome }) => {
    const queue = createModeQueue();
    queue.push(
      { text: 'hello', localId: 'local-1' },
      { permissionMode: 'default' },
      { userMessageLocalId: 'local-1' },
    );

    let metadata: Record<string, unknown> = {
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    };
    const blockPendingMessageDelivery = vi.fn(async () => true);
    const providerInputOutcomeObserver = vi.fn();
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
      blockPendingMessageDelivery,
    };
    const runtime = {
      beginTurn: vi.fn(),
      startOrLoad: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => undefined),
      sendPromptWithMeta: vi.fn(async () => {
        throw error;
      }),
      failTurn: vi.fn(async () => true),
      flushTurn: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
      getSessionId: vi.fn(() => 'test-session'),
    };
    let shouldExit = false;

    await runPermissionModePromptLoop({
      providerName: 'Test ACP',
      agentMessageType: 'qwen',
      explicitPermissionMode: 'default',
      session: session as any,
      providerInputOutcomeObserver,
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
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => String(error),
    });

    expect(providerInputOutcomeObserver).toHaveBeenCalledWith(expectedOutcome);
    expect(runtime.sendPromptWithMeta).toHaveBeenCalledTimes(1);
    expect(blockPendingMessageDelivery).not.toHaveBeenCalled();
  });
});

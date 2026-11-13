import { SessionMessageMetaSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageMeta';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { RuntimeConfigUpdateOutcomeV1 } from '@happier-dev/agents';
import type { RuntimeTranscriptProjectionSession } from './session/transcripts/projectRuntimeTranscriptEvent';
import { describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';

import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import { createRuntimeOverrideSynchronizers } from './createRuntimeOverrideSynchronizers';
import { writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';

describe('createRuntimeOverrideSynchronizers', () => {
  it.each(['claude_model_option_unsupported', 'claude_provider_model_option_unsupported', null])(
    'persists a readable configuration refusal with its sanitized typed cause (%s)', async (code) => {
      const message = "Model 'muse-spark-1.2' does not support this Claude configuration option.";
      // Recorded Claude producer shape: no option id/value or details are supplied.
      const outcome: RuntimeConfigUpdateOutcomeV1 = { status: 'unsupported', reason: message,
        ...(code ? { diagnostic: { code, severity: 'error', message } } : {}) };
      const enqueueAgentMessageCommitted = vi.fn<NonNullable<RuntimeTranscriptProjectionSession['enqueueAgentMessageCommitted']>>(async () => ({ persisted: true, delivered: true }));
      const session = { sessionId: 'config-refusal', enqueueAgentMessageCommitted,
        getMetadataSnapshot: () => createTestMetadata({ sessionConfigOptionOverridesV1: {
          v: 1, updatedAt: 11, overrides: { reasoning_effort: { value: 'minimal', updatedAt: 11 } },
        } }) };
      const sync = createRuntimeOverrideSynchronizers({ agentTargetKey: 'agent:happier.agent.claude/claude', session,
        runtime: { setSessionMode: async () => {}, setSessionModelSelection: async () => {},
          setSessionConfigOption: async () => outcome }, isStarted: () => true,
        configOptionRejectionTranscript: { session, provider: 'claude' } });
      sync.syncFromMetadata();
      await sync.flushPendingAfterStart();
      // A settled refusal writes one row, even when the unchanged intent is seen again.
      sync.syncFromMetadata();
      await sync.flushPendingAfterStart();
      expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(1);
      const call = enqueueAgentMessageCommitted.mock.calls[0]!;
      expect(call[1]).toEqual({ type: 'message', message });
      const meta = createStoredReadSchema(SessionMessageMetaSchema).parse(call[2].meta ?? {});
      if (code) {
        expect(meta).toMatchObject({ source: 'runtime', runtimeIssueCode: code,
          runtimeIssueV1: { code, source: 'agent_session_error', sanitizedPreview: message } });
      } else {
        expect(meta.runtimeIssueV1).toBeUndefined();
      }
    });

  it('holds the existing before-prompt override flush while a capability apply restart is in flight', async () => {
    let metadata = createTestMetadata();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let requestEntered = false;
    const session = { sessionId: 'session', getMetadataSnapshot: () => metadata,
      updateMetadataAsCurrentPublisher: async (update: (current: typeof metadata) => typeof metadata) => { metadata = update(metadata); } };
    const sync = createRuntimeOverrideSynchronizers({ agentTargetKey: 'backend:claude', session,
      runtime: { setSessionMode: async () => {}, setSessionConfigOption: async () => {}, setSessionModelSelection: async () => {} },
      isStarted: () => true, capabilitySelection: { session, agent: { vendorResume: 'supported', skillsLiveReload: 'unsupported' },
        isStarted: () => true, isSettled: () => true,
        requestRestart: async () => { requestEntered = true; await held; return { ok: true, status: 'restarted', sessionId: 'session' }; },
      } });
    metadata = writeSessionCapabilitySelectionToMetadataV1(metadata,
      { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] } }, { sessionActive: true });
    sync.syncFromMetadata();
    let flushed = false;
    const flush = sync.flushPendingAfterStart().then(() => { flushed = true; });
    try {
      await expect.poll(() => requestEntered).toBe(true);
      await setImmediate();
      expect(flushed).toBe(false);
    } finally { release(); await flush; }
  });
  it('applies metadata-only permission mode updates through the runtime target', async () => {
    const setPermissionMode = vi.fn(async (_mode: string) => {});

    const sync = createRuntimeOverrideSynchronizers({
      agentTargetKey: 'agent:happier.agent.codex/codex',
      session: {
        getMetadataSnapshot: () => createTestMetadata({ permissionMode: 'yolo', permissionModeUpdatedAt: 42 }),
      },
      runtime: {
        setPermissionMode,
        setSessionMode: async () => {},
        setSessionConfigOption: async () => {},
        setSessionModelSelection: async () => {},
      },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await Promise.resolve();

    expect(setPermissionMode).toHaveBeenCalledTimes(1);
    expect(setPermissionMode).toHaveBeenCalledWith('yolo');
  });

  it('applies metadata model overrides before model-scoped config options', async () => {
    const calls: string[] = [];

    const sync = createRuntimeOverrideSynchronizers({
      agentTargetKey: 'agent:happier.agent.codex/codex',
      session: {
        getMetadataSnapshot: () =>
          createTestMetadata({
            modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gpt-5.5' },
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 11,
              overrides: {
                reasoning_effort: { updatedAt: 11, value: 'high' },
              },
            },
          }),
      },
      runtime: {
        setSessionMode: async (modeId: string) => {
          calls.push(`mode:${modeId}`);
        },
        setPermissionMode: async (permissionMode) => {
          calls.push(`permission:${permissionMode}`);
        },
        setSessionModelSelection: async (selection) => {
          calls.push(`model:${selection.modelId}`);
        },
        setSessionConfigOption: async (configId, value) => {
          calls.push(`config:${configId}:${String(value)}`);
        },
      },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();

    expect(calls).toEqual([
      'model:gpt-5.5',
      'config:reasoning_effort:high',
    ]);
  });

  it('waits for an async model override before applying model-scoped config options on started metadata sync', async () => {
    const calls: string[] = [];
    let resolveModel!: () => void;
    const modelApplied = new Promise<void>((resolve) => {
      resolveModel = resolve;
    });

    const sync = createRuntimeOverrideSynchronizers({
      agentTargetKey: 'agent:happier.agent.codex/codex',
      session: {
        getMetadataSnapshot: () =>
          createTestMetadata({
            modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gpt-5.5' },
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 11,
              overrides: {
                reasoning_effort: { updatedAt: 11, value: 'xhigh' },
              },
            },
          }),
      },
      runtime: {
        setSessionMode: async (modeId: string) => {
          calls.push(`mode:${modeId}`);
        },
        setPermissionMode: async (permissionMode) => {
          calls.push(`permission:${permissionMode}`);
        },
        setSessionModelSelection: async (selection) => {
          calls.push(`model:${selection.modelId}`);
          await modelApplied;
        },
        setSessionConfigOption: async (configId, value) => {
          calls.push(`config:${configId}:${String(value)}`);
        },
      },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(['model:gpt-5.5']);

    resolveModel();
    await modelApplied;
    await sync.flushPendingAfterStart();

    expect(calls).toEqual([
      'model:gpt-5.5',
      'config:reasoning_effort:xhigh',
    ]);
  });

  it('delegates a newer metadata model proposal while the owning transition is still in flight', async () => {
    let metadata = createTestMetadata({
      modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gpt-5.5' },
    });
    let resolveFirst!: () => void;
    const firstTransition = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const setSessionModelSelection = vi.fn(async (selection: { modelId: string }) => {
      if (selection.modelId === 'gpt-5.5') {
        await firstTransition;
      }
    });

    const sync = createRuntimeOverrideSynchronizers({
      agentTargetKey: 'agent:happier.agent.codex/codex',
      session: {
        getMetadataSnapshot: () => metadata,
      },
      runtime: {
        setSessionMode: async () => {},
        setPermissionMode: async () => {},
        setSessionModelSelection,
        setSessionConfigOption: async () => {},
      },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await vi.waitFor(() => {
      expect(setSessionModelSelection).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 'gpt-5.5' }),
      );
    });

    metadata = createTestMetadata({
      modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'gpt-5.6' },
    });
    sync.syncFromMetadata();

    await vi.waitFor(() => {
      expect(setSessionModelSelection).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 'gpt-5.6' }),
      );
    });

    resolveFirst();
    await sync.flushPendingAfterStart();
  });

  it('flushes pending model overrides before pending model-scoped config options after runtime start', async () => {
    const calls: string[] = [];
    let started = false;

    const sync = createRuntimeOverrideSynchronizers({
      agentTargetKey: 'agent:happier.agent.codex/codex',
      session: {
        getMetadataSnapshot: () =>
          createTestMetadata({
            modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gpt-5.4-mini' },
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 11,
              overrides: {
                reasoning_effort: { updatedAt: 11, value: 'medium' },
              },
            },
          }),
      },
      runtime: {
        setSessionMode: async (modeId: string) => {
          calls.push(`mode:${modeId}`);
        },
        setPermissionMode: async (permissionMode) => {
          calls.push(`permission:${permissionMode}`);
        },
        setSessionModelSelection: async (selection) => {
          calls.push(`model:${selection.modelId}`);
        },
        setSessionConfigOption: async (configId, value) => {
          calls.push(`config:${configId}:${String(value)}`);
        },
      },
      isStarted: () => started,
    });

    sync.syncFromMetadata();
    expect(calls).toEqual([]);

    started = true;
    await sync.flushPendingAfterStart();

    expect(calls).toEqual([
      'model:gpt-5.4-mini',
      'config:reasoning_effort:medium',
    ]);
  });
});

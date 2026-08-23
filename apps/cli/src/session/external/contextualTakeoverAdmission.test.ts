import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveExternalSessionOperationTimelineV1,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationSemanticRequestV1,
  type ExternalSessionTakeoverStartInputV1,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readExternalSessionOperationRecord,
  writeExternalSessionOperationRecord,
} from '@/session/actions/externalSessions/operationRecordStore';

import {
  createContextualExternalSessionTakeoverAdapter,
  type ContextualExternalSessionTakeoverAuthorIntent,
  type ContextualExternalSessionTakeoverDependencies,
} from './contextualTakeoverAdmission';
import { deriveExternalSessionPluginOperationDurableKey } from './pluginOperationDurableKey';

const roots: string[] = [];
const ref = Object.freeze({
  agentId: 'codex',
  sourceId: 'codexHome:user:::',
  remoteSessionId: 'remote-1',
});
const source = Object.freeze({ kind: 'codexHome', home: '/tmp/codex' });

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-contextual-takeover-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })
  ));
});

function authorIntent(
  inputRef = ref,
  targetStorageMode: 'external-linked' | 'persisted' = 'persisted',
): ContextualExternalSessionTakeoverAuthorIntent {
  return {
    v: 1,
    surface: 'plugin',
    kind: 'takeover',
    agentId: inputRef.agentId,
    sourceId: inputRef.sourceId,
    remoteSessionId: inputRef.remoteSessionId,
    targetStorageMode,
  };
}

function startRequest(input: Readonly<{
  sessionId: string;
  durableIdempotencyKey: string;
  targetStorageMode: 'external-linked' | 'persisted';
}>): ExternalSessionTakeoverStartInputV1['request'] {
  return {
    v: 1,
    idempotencyKey: input.durableIdempotencyKey,
    sessionId: input.sessionId,
    source: {
      machineId: 'machine-1',
      remoteSessionId: ref.remoteSessionId,
      qualifiedIdentity: {
        v: 1,
        agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
        source: { kind: 'codexHome', contractVersion: 1 },
      },
      linkGeneration: 'link-1',
    },
    plan: 'takeover',
    targetStorageMode: input.targetStorageMode,
    targetDirectory: '/local/selected/workspace',
    targetRuntimeMode: 'terminal',
  };
}

function durableRecord(input: Readonly<{
  pluginId: string;
  callerKey: string;
  operationId?: string;
  sessionId?: string;
  inputRef?: typeof ref;
  targetStorageMode?: 'external-linked' | 'persisted';
}>): ExternalSessionOperationRecordV1 {
  const inputRef = input.inputRef ?? ref;
  const targetStorageMode = input.targetStorageMode ?? 'persisted';
  const request = {
    ...startRequest({
      sessionId: input.sessionId ?? 'session-1',
      durableIdempotencyKey:
        deriveExternalSessionPluginOperationDurableKey({
          pluginId: input.pluginId,
          callerKey: input.callerKey,
        }),
      targetStorageMode,
    }),
    source: {
      ...startRequest({
        sessionId: input.sessionId ?? 'session-1',
        durableIdempotencyKey: 'unused',
        targetStorageMode,
      }).source,
      remoteSessionId: inputRef.remoteSessionId,
      sourceGeneration: 'source-generation-1',
      contributionGeneration: 'contribution-generation-1',
    },
  } satisfies Extract<
    ExternalSessionOperationSemanticRequestV1,
    { plan: 'takeover' }
  >;
  return {
    v: 1,
    operationId: input.operationId ?? 'external-takeover:existing-plugin-row',
    revision: 3,
    request,
    authorIntent: authorIntent(inputRef, targetStorageMode),
    status: 'awaiting_user_resume',
    phase: 'validating',
    timeline: resolveExternalSessionOperationTimelineV1(request),
    createdAtMs: 1,
    updatedAtMs: 1,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: 'machine_only',
    checkpoint: {
      sourcePagesRead: 0,
      stagedItemCount: 0,
      importedItemCount: 0,
      requiredItemFailures: {
        total: 0,
        record: 0,
        media: 0,
        conversion: 0,
        diagnosticsTruncated: false,
        diagnostics: [],
      },
    },
    bindings: { operationClaimId: 'claim-1' },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: {
      linkedSessionRevision: 1,
      sourceSnapshotEvidenceRef: 'cursor-1',
    },
    fence: { kind: 'none' },
    retryTargetPhase: 'validating',
  };
}

function dependencies(input: Readonly<{
  activeServerDir: string;
  pluginId?: string;
  startDurableTakeover?: ContextualExternalSessionTakeoverDependencies['startDurableTakeover'];
}>) {
  const calls: string[] = [];
  const resolveCurrentSource = vi.fn<
    ContextualExternalSessionTakeoverDependencies['resolveCurrentSource']
  >(async () => {
    calls.push('source');
    return {
      source,
      externalLinkedTakeoverWriterSafety: 'native_prevention' as const,
    };
  });
  const ensureLink = vi.fn(async () => {
    calls.push('link');
    return { sessionId: 'session-linked' };
  });
  const deriveTakeoverStartRequest = vi.fn(async (requestInput) => {
    calls.push('derive');
    return startRequest({
      sessionId: requestInput.sessionId,
      durableIdempotencyKey: requestInput.durableIdempotencyKey,
      targetStorageMode: requestInput.targetStorageMode,
    });
  });
  const startDurableTakeover = input.startDurableTakeover ?? vi.fn(async (
    raw: unknown,
  ) => {
    calls.push('start');
    const request = (raw as { request: ExternalSessionTakeoverStartInputV1['request'] }).request;
    return {
      ok: true as const,
      operation: {
        sessionId: request.sessionId,
        operationId: 'external-takeover:new-plugin-operation',
        revision: 0,
      },
    };
  });
  return {
    calls,
    resolveCurrentSource,
    ensureLink,
    deriveTakeoverStartRequest,
    startDurableTakeover,
    value: {
      activeServerDir: input.activeServerDir,
      pluginId: input.pluginId ?? 'plugin.alpha',
      resolveCurrentSource,
      ensureLink,
      deriveTakeoverStartRequest,
      startDurableTakeover,
      nowMs: () => 5,
    } satisfies ContextualExternalSessionTakeoverDependencies,
  };
}

describe('contextual External Sessions takeover durable admission', () => {
  it('validates the stable ref and opaque caller key before source, link, or start effects', async () => {
    const activeServerDir = await createRoot();
    const harness = dependencies({ activeServerDir });
    const adapter = createContextualExternalSessionTakeoverAdapter(
      harness.value,
    );
    const invalidCases = [
      { ref: null, key: 'key' },
      { ref: { ...ref, agentId: ' codex' }, key: 'key' },
      { ref: { ...ref, sourceId: '' }, key: 'key' },
      { ref: { ...ref, remoteSessionId: 'remote ' }, key: 'key' },
      { ref, key: '' },
      { ref, key: ' key' },
      { ref, key: 'x'.repeat(257) },
    ];
    for (const invalid of invalidCases) {
      await expect(adapter.takeover(invalid.ref as typeof ref, {
        targetStorageMode: 'persisted',
        idempotencyKey: invalid.key,
      })).rejects.toBeInstanceOf(PluginError);
    }
    await expect(adapter.takeover(
      ref,
      null as unknown as Parameters<typeof adapter.takeover>[1],
    )).rejects.toBeInstanceOf(PluginError);
    await expect(adapter.takeover(ref, {
      targetStorageMode: 'persisted',
      targetDirectory: '/caller-selected/workspace',
      idempotencyKey: 'caller-selected-directory',
    } as never)).rejects.toMatchObject({
      code: 'plugin_external_takeover_request_invalid',
    });
    expect(harness.calls).toEqual([]);
  });

  it('resolves same-principal replay and changed intent globally before source/link effects while isolating plugins', async () => {
    const activeServerDir = await createRoot();
    const callerKey = '\uD800';
    const existing = durableRecord({
      pluginId: 'plugin.alpha',
      callerKey,
    });
    await writeExternalSessionOperationRecord(activeServerDir, existing);

    const alpha = dependencies({ activeServerDir, pluginId: 'plugin.alpha' });
    const alphaAdapter = createContextualExternalSessionTakeoverAdapter(
      alpha.value,
    );
    await expect(alphaAdapter.takeover(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: callerKey,
    })).resolves.toEqual({
      sessionId: existing.request.sessionId,
      operationId: existing.operationId,
      revision: existing.revision,
    });
    await expect(alphaAdapter.takeover(
      { ...ref, remoteSessionId: 'remote-2' },
      {
        targetStorageMode: 'persisted',
        idempotencyKey: callerKey,
      },
    )).rejects.toMatchObject({
      code: 'plugin_external_takeover_idempotency_conflict',
    });
    expect(alpha.calls).toEqual([]);

    for (const distinctCallerKey of ['\uD801', '\uFFFD']) {
      await expect(alphaAdapter.takeover(ref, {
        targetStorageMode: 'persisted',
        idempotencyKey: distinctCallerKey,
      })).resolves.toMatchObject({
        operationId: 'external-takeover:new-plugin-operation',
      });
    }
    expect(alpha.calls).toEqual([
      'source', 'link', 'derive', 'start',
      'source', 'link', 'derive', 'start',
    ]);

    const beta = dependencies({ activeServerDir, pluginId: 'plugin.beta' });
    await expect(createContextualExternalSessionTakeoverAdapter(
      beta.value,
    ).takeover(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: callerKey,
    })).resolves.toMatchObject({
      operationId: 'external-takeover:new-plugin-operation',
    });
    expect(beta.calls).toEqual(['source', 'link', 'derive', 'start']);
  });

  it('refuses an unsupported external-linked writer-safety contract before any link or durable Start', async () => {
    const activeServerDir = await createRoot();
    const harness = dependencies({ activeServerDir });
    harness.resolveCurrentSource.mockImplementation(async () => {
      harness.calls.push('source');
      return {
        source,
        externalLinkedTakeoverWriterSafety: 'unsupported' as const,
      };
    });
    const adapter = createContextualExternalSessionTakeoverAdapter(
      harness.value,
    );

    await expect(adapter.takeover(ref, {
      targetStorageMode: 'external-linked',
      idempotencyKey: 'unsupported-writer-safety',
    })).rejects.toMatchObject({
      code: 'plugin_external_takeover_writer_safety_unsupported',
    });

    expect(harness.calls).toEqual(['source']);
    expect(harness.ensureLink).not.toHaveBeenCalled();
    expect(harness.deriveTakeoverStartRequest).not.toHaveBeenCalled();
    expect(harness.startDurableTakeover).not.toHaveBeenCalled();
    expect(await readExternalSessionOperationRecord(
      activeServerDir,
      'external-takeover:new-plugin-operation',
    )).toBeNull();

    // The same unsupported Agent still admits the persisted mode.
    await expect(adapter.takeover(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'unsupported-writer-safety-persisted',
    })).resolves.toMatchObject({
      operationId: 'external-takeover:new-plugin-operation',
    });
    expect(harness.ensureLink).toHaveBeenCalledOnce();
  });

  it.each(['external-linked', 'persisted'] as const)(
    'links before canonical durable %s Start and leaves the link when Start fails',
    async (targetStorageMode) => {
      const activeServerDir = await createRoot();
      const harness = dependencies({
        activeServerDir,
        startDurableTakeover: vi.fn(async () => {
          harness.calls.push('start');
          return {
            ok: false as const,
            error: {
              code: 'internal_error' as const,
              message: 'durable Start failed',
            },
          };
        }),
      });
      const adapter = createContextualExternalSessionTakeoverAdapter(
        harness.value,
      );

      await expect(adapter.takeover(ref, {
        targetStorageMode,
        idempotencyKey: `key-${targetStorageMode}`,
      })).rejects.toMatchObject({ code: 'plugin_external_takeover_failed' });
      expect(harness.calls).toEqual(['source', 'link', 'derive', 'start']);
      expect(harness.ensureLink).toHaveBeenCalledOnce();
    },
  );

  it('fences a retired configured snapshot after source resolution and freshly resolves a same-tuple retry', async () => {
    const activeServerDir = await createRoot();
    const harness = dependencies({ activeServerDir });
    const oldSource = Object.freeze({ kind: 'codexHome', home: '/tmp/old' });
    const currentSource = Object.freeze({ kind: 'codexHome', home: '/tmp/current' });
    let releaseOldResolution!: () => void;
    const oldResolution = new Promise<void>((resolve) => {
      releaseOldResolution = resolve;
    });
    harness.resolveCurrentSource
      .mockImplementationOnce(async () => {
        harness.calls.push('source');
        await oldResolution;
        return {
          source: oldSource,
          externalLinkedTakeoverWriterSafety: 'native_prevention' as const,
        };
      })
      .mockImplementationOnce(async () => {
        harness.calls.push('source');
        return {
          source: currentSource,
          externalLinkedTakeoverWriterSafety: 'native_prevention' as const,
        };
      });
    const adapter = createContextualExternalSessionTakeoverAdapter(
      harness.value,
    );
    const caller = new AbortController();
    const oldRetirement = new AbortController();
    let oldCurrent = true;

    const staleAttempt = adapter.takeover(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'retired-source-resolution',
    }, {
      signal: caller.signal,
      retirementSignal: oldRetirement.signal,
      isCurrent: () => oldCurrent,
    });
    await vi.waitFor(() => expect(harness.resolveCurrentSource).toHaveBeenCalledOnce());
    oldCurrent = false;
    oldRetirement.abort();
    releaseOldResolution();

    await expect(staleAttempt).rejects.toMatchObject({
      code: 'plugin_generation_retired',
    });
    expect(harness.ensureLink).not.toHaveBeenCalled();
    expect(harness.startDurableTakeover).not.toHaveBeenCalled();

    const currentRetirement = new AbortController();
    await expect(adapter.takeover(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'retired-source-resolution',
    }, {
      signal: caller.signal,
      retirementSignal: currentRetirement.signal,
      isCurrent: () => true,
    })).resolves.toMatchObject({
      operationId: 'external-takeover:new-plugin-operation',
    });
    expect(harness.resolveCurrentSource).toHaveBeenCalledTimes(2);
    expect(harness.ensureLink).toHaveBeenCalledOnce();
    expect(harness.ensureLink).toHaveBeenCalledWith(expect.objectContaining({
      source: currentSource,
    }));
    expect(harness.startDurableTakeover).toHaveBeenCalledOnce();
  });

  it('preserves caller cancellation precedence when snapshot retirement is concurrent', async () => {
    const activeServerDir = await createRoot();
    const harness = dependencies({ activeServerDir });
    const caller = new AbortController();
    const retirement = new AbortController();
    caller.abort();
    retirement.abort();

    await expect(createContextualExternalSessionTakeoverAdapter(
      harness.value,
    ).takeover(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'concurrent-cancellation',
    }, {
      signal: caller.signal,
      retirementSignal: retirement.signal,
      isCurrent: () => false,
    })).rejects.toMatchObject({ code: 'plugin_operation_aborted' });
    expect(harness.calls).toEqual([]);
  });

  it('rejects private Start authority for a different logical Agent before durable Start', async () => {
    const activeServerDir = await createRoot();
    const harness = dependencies({ activeServerDir });
    harness.deriveTakeoverStartRequest.mockImplementationOnce(async (
      requestInput,
    ) => {
      harness.calls.push('derive');
      const request = startRequest({
        sessionId: requestInput.sessionId,
        durableIdempotencyKey: requestInput.durableIdempotencyKey,
        targetStorageMode: requestInput.targetStorageMode,
      });
      return {
        ...request,
        source: {
          ...request.source,
          qualifiedIdentity: {
            ...request.source.qualifiedIdentity,
            agent: {
              ...request.source.qualifiedIdentity.agent,
              localId: 'different-agent',
            },
          },
        },
      };
    });
    const adapter = createContextualExternalSessionTakeoverAdapter(
      harness.value,
    );

    await expect(adapter.takeover(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'wrong-private-agent',
    })).rejects.toMatchObject({
      code: 'plugin_external_takeover_private_request_invalid',
    });
    expect(harness.calls).toEqual(['source', 'link', 'derive']);
  });

  it('returns a committed operation after an outcome-unknown throw without replaying source or link', async () => {
    const activeServerDir = await createRoot();
    const pluginId = 'plugin.alpha';
    const callerKey = 'unknown-outcome-key';
    const committed = durableRecord({
      pluginId,
      callerKey,
      operationId: 'external-takeover:committed-before-loss',
      sessionId: 'session-linked',
    });
    let harness: ReturnType<typeof dependencies>;
    harness = dependencies({
      activeServerDir,
      pluginId,
      startDurableTakeover: vi.fn(async () => {
        harness.calls.push('start');
        await writeExternalSessionOperationRecord(activeServerDir, committed);
        throw new Error('response_lost');
      }),
    });
    const adapter = createContextualExternalSessionTakeoverAdapter(
      harness.value,
    );

    await expect(adapter.takeover(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: callerKey,
    })).resolves.toEqual({
      sessionId: committed.request.sessionId,
      operationId: committed.operationId,
      revision: committed.revision,
    });
    expect(harness.calls).toEqual(['source', 'link', 'derive', 'start']);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      committed.operationId,
    )).resolves.toEqual(committed);
  });
});

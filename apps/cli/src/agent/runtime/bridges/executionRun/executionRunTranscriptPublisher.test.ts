import { expect, it } from 'vitest';

import { prepareAcpTranscriptDispatch } from '@/api/session/outbound/transcriptDispatch';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { createCommittedExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';

it('stores a captured comparison once when SCM result metadata repeats the result body', async () => {
  const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'captured',
    metadata: { source: { kind: 'workingTree' }, sourceKey: 'captured' },
    comparison: { id: 'captured', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {},
      inventory: { state: 'complete', reasons: [], files: [{ path: 'a.ts', changeKind: 'modified',
        binary: false, generated: false, lockfile: false, occurrences: [],
        evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' } }] } },
    requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: {
      title: 'Captured reading', intro: '', stops: [], otherChangeRefs: [],
    } } }, analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
  });
  const rows: { body: ACPMessageData; meta: Record<string, unknown> | undefined }[] = [];
  const publish = createCommittedExecutionRunTranscriptPublisher({
    readParentToolNormalizationSource: () => null,
    // Durable storage is the boundary; the Run publisher remains real.
    enqueueAgentMessageCommitted: async (_provider, body, opts) => {
      rows.push({ body, meta: opts.meta });
      return { persisted: true, delivered: true };
    },
  });
  const happier = { kind: 'scm_diff_summary.v1', payload: structuredClone(output) };
  const meta = { happier, scmResultUpdate: { status: 'published' } };
  await publish('codex', { type: 'tool-result', id: 'result', callId: 'run-call', output }, { meta });
  expect(rows[0]?.meta).toEqual({ ...meta, happier: { kind: happier.kind } });
  expect(rows[0]?.body).toMatchObject({ output });
  expect(JSON.stringify(rows[0]).match(/unifiedDiff/g)).toHaveLength(1);
  expect(meta.happier.payload).toEqual(output);

  // A sidechain has no result body, and distinct metadata is not a duplicate.
  await publish('codex', { type: 'message', message: 'Saved.', sidechainId: 'run-call' }, { meta });
  await publish('codex', { type: 'tool-result', id: 'different', callId: 'run-call', output: { status: 'succeeded' } }, { meta });
  expect(rows[1]?.meta).toEqual(meta);
  expect(rows[2]?.meta).toEqual(meta);
});

it.each(['parent', 'child'] as const)('publishes admitted %s tool provenance through committed Run custody', async owner => {
  const parentSource = { protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
  const childSource = { protocol: 'acp', agent: { pluginId: 'example.child', localId: 'worker' } } as const;
  const expectedSource = owner === 'child' ? childSource : parentSource;
  const rows: ACPMessageData[] = [];
  const caches = {
    toolCallCanonicalNameByProviderAndId: new Map<string, { rawToolName: string; canonicalToolName: string }>(),
    permissionToolCallRawInputByProviderAndId: new Map<string, unknown>(),
    toolCallInputByProviderAndId: new Map<string, unknown>(),
  };
  const publish = createCommittedExecutionRunTranscriptPublisher({
    readParentToolNormalizationSource: () => parentSource,
    // Durable transcript storage is the boundary; the publisher and normalizer remain real.
    enqueueAgentMessageCommitted: async (provider, body, opts) => {
      rows.push(prepareAcpTranscriptDispatch({ ...caches, provider, body, source: opts.toolNormalizationSource,
        localId: opts.localId, meta: opts.meta }).normalizedBody);
      return { persisted: true, delivered: true };
    },
  });
  const options = { meta: {}, ...(owner === 'child' ? { toolNormalizationSource: childSource } : {}) };
  await publish('codex', { type: 'tool-call', callId: 'run-call', id: 'call', name: 'SubAgentRun',
    input: { runId: 'run' } }, options);
  await publish('codex', { type: 'tool-result', callId: 'run-call', id: 'result', output: { status: 'succeeded' } }, options);

  expect(rows).toMatchObject([
    { type: 'tool-call', input: { _happier: { v: 3, ...expectedSource } } },
    { type: 'tool-result', output: { _happier: { v: 3, ...expectedSource } } },
  ]);
});

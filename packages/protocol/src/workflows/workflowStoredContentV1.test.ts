import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import type { AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';
import { encodeBase64 } from '../crypto/base64.js';
import { MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES } from '../automations/automationStoredContentEnvelopeV1.js';
import { createDeepWorkflowDefinition } from './workflowDefinition.testkit.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { WorkflowAcceptedSnapshotV1Schema } from './workflowDefinitionV1.js';
import {
  WorkflowCheckpointEnvelopeV1Schema,
  WorkflowFinalResultV1Schema,
  WorkflowProgressEnvelopeV1Schema,
} from './workflowProgressV1.js';
import { deriveWorkflowPlanRunIdV1 } from './workflowInvocationIdentityV1.js';
import { parseWorkflowDocumentV1, parseWorkflowDocumentJsonV1, serializeWorkflowDocumentJsonV1 } from './workflowDocumentV1.js';
import {
  openWorkflowAcceptedSnapshotStoredEnvelopeV1,
  openWorkflowCheckpointStoredEnvelopeV1,
  openWorkflowFinalResultStoredEnvelopeV1,
  openWorkflowProgressStoredEnvelopeV1,
  openWorkflowProgressSnapshotV1,
  prepareWorkflowDestinationPublicationV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowFinalResultStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  validateWorkflowStoredEnvelopeOuterForModeV1,
  parseWorkflowStoredContentEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
} from './workflowStoredContentV1.js';

const material: AccountScopedCryptoMaterial = {
  type: 'dataKey',
  machineKey: new Uint8Array(32).fill(7),
};
const runDataKey = new Uint8Array(32).fill(7);
const randomBytes = (length: number) => new Uint8Array(length).fill(3);

const acceptedBinding = {
  v: 1 as const,
  purpose: 'accepted_snapshot' as const,
  accountId: 'account-1',
  runId: 'run-1',
};
const progressBinding = {
  v: 1 as const,
  purpose: 'invocation_progress' as const,
  accountId: 'account-1',
  runId: 'run-1',
  recordId: 'row-1',
  sequence: '0',
  parentRecordId: null,
  memberOrdinal: '0',
  attempt: '0',
};
const checkpointBinding = {
  v: 1 as const,
  purpose: 'checkpoint' as const,
  accountId: 'account-1',
  runId: 'run-1',
};
const finalResultBinding = {
  v: 1 as const,
  purpose: 'final_result' as const,
  accountId: 'account-1',
  runId: 'run-1',
};

describe('Workflow stored Account content', () => {
  it('opens exact encrypted destination deltas across restart and rejects missing, swapped or rolled-back rows', () => {
    let nonce = 0;
    const sealMode = { mode: 'e2ee' as const, runDataKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(++nonce) };
    const binding = { ...progressBinding, recordId: 'root' };
    const initial = WorkflowProgressEnvelopeV1Schema.parse({
      kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
      blockKind: 'root', logicalInvocationRecordId: 'root', attempt: '0',
      stepProgress: { completed: 0, total: 2, destinations: [
        { sourceKey: '$root', blockId: 'first', sessionIds: ['private-session'] },
        { sourceKey: '$root', blockId: 'second', sessionIds: [] },
      ] },
    });
    const publish = (progress: typeof initial, previous?: typeof initial) => {
      const publication = prepareWorkflowDestinationPublicationV1({
        ...sealMode, accountId: binding.accountId, runId: binding.runId, progress, previous,
      });
      return { ...publication, envelope: sealWorkflowProgressStoredEnvelopeV1({ ...sealMode, binding, progress: publication.progress }) };
    };
    const open = (envelope: unknown, destinationEnvelopes: unknown) =>
      openWorkflowProgressSnapshotV1({ ...sealMode, binding, envelope, destinationEnvelopes });
    const seed = publish(initial);
    const original = seed.destinationWrites.map(write => write.contentEnvelope);
    const prior = open(seed.envelope, original);
    if (prior.kind !== 'available') throw new Error(prior.kind);
    const [first, second] = prior.content.stepProgress!.destinations!;
    const next = { ...first, observation: { recordId: 'leaf', sequence: '1', attempt: '0', contentRevision: '2',
      lifecycle: 'completed' as const } };
    const updated = publish({ ...prior.content, stepProgress: { completed: 1, total: 2, destinations: [next, second] } }, prior.content);
    expect(updated.destinationWrites.map(write => write.ordinal)).toEqual([0]);
    const merged = [updated.destinationWrites[0]!.contentEnvelope, original[1]!];
    expect(JSON.stringify([seed.envelope, updated.envelope, merged])).not.toContain('private-session');
    expect(open(updated.envelope, merged)).toMatchObject({ kind: 'available', content: {
      stepProgress: { completed: 1, destinations: [next, second] },
    } });
    expect(open(updated.envelope, original)).toEqual({ kind: 'contentInvalid' });
    expect(open(updated.envelope, merged.slice(0, 1))).toEqual({ kind: 'contentInvalid' });
    expect(open(updated.envelope, [...merged].reverse())).toEqual({ kind: 'bindingMismatch' });
  });

  it.each(['plain', 'e2ee'] as const)('round-trips accepted Runs above the Automation envelope ceiling (%s)', (mode) => {
    const definition = { ...createDeepWorkflowDefinition(0),
      inputs: [{ name: 'payload', valueType: 'string' as const, required: true }] };
    const payload = 'é'.repeat(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES / 2);
    const acceptedSnapshot = { startedBy: 'user' as const, authoredDefinition: definition, definition,
      workDepth: 0, metadata: null, materializedLeaves: [], frozenChildren: {}, inputs: { payload }, machineId: 'machine-1',
      executionTarget: { kind: 'session' as const },
      workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
      source: { kind: 'inline' as const }, origin: { kind: 'direct' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } } };
    const envelope = sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ binding: acceptedBinding, acceptedSnapshot,
      ...(mode === 'plain' ? { mode } : { mode, runDataKey, randomBytes }) });
    const serialized = serializeWorkflowStoredContentEnvelopeV1(envelope);
    expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES);
    const stored = parseWorkflowStoredContentEnvelopeV1(serialized);
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode, binding: acceptedBinding, envelope: stored, runDataKey });
    expect(opened).toMatchObject({ kind: 'available', content: { inputs: { payload } } });
  });
  it('refuses unknown approved-operation restrictions instead of opening exact unbound consent', () => {
    const definition = createDeepWorkflowDefinition(0);
    const approvedOperation = { parent: { actionId: 'workflow.trigger.add', input: {} },
      approvedBy: { accountId: 'owner' }, steps: [{ actionId: 'deployments.deploy',
        input: { serverId: 'home', environmentId: 'staging', targetLinkId: 'link' } }] };
    const acceptedSnapshot = { startedBy: 'user' as const, authoredDefinition: definition, definition,
      workDepth: 0, metadata: null, materializedLeaves: [], frozenChildren: {}, inputs: {}, machineId: 'machine-1',
      executionTarget: { kind: 'session' as const },
      workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
      source: { kind: 'inline' as const }, origin: { kind: 'direct' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } },
      approvedOperation };
    const envelope = sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', binding: acceptedBinding, acceptedSnapshot });
    expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', binding: acceptedBinding, envelope }))
      .toMatchObject({ kind: 'available', content: { approvedOperation } });
    for (const restricted of [
      { ...approvedOperation, effectRestriction: { requiresFreshApproval: true } },
      { ...approvedOperation, steps: [{ ...approvedOperation.steps[0], effectRestriction: { requiresFreshApproval: true } }] },
    ]) {
      expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', binding: acceptedBinding,
        envelope: { t: 'plain', v: { v: 2, binding: acceptedBinding,
          content: { ...acceptedSnapshot, approvedOperation: restricted } } } }))
        .toEqual({ kind: 'payloadInvalid' });
    }
  });
  it('retains declared result field order through workflow JSON interchange', () => {
    const document = { kind: 'happier.workflow', version: 1, definition: { version: 1, inputs: [], defaults: createDeepWorkflowDefinition(0).defaults,
      blocks: [{ kind: 'step', id: 'gather', document: { text: 'Gather changes', references: [], attachments: [] }, input: [],
        execution: { modelSelection: null, permissionMode: 'default' },
        result: { kind: 'json', schema: { type: 'object', properties: {
          issues: { type: 'string' }, commits: { type: 'string' },
        } } } }],
    } };
    const imported = parseWorkflowDocumentJsonV1(serializeWorkflowDocumentJsonV1(document));
    const leaf = imported.definition.blocks[0]!;
    if (leaf.kind !== 'step' || leaf.result.kind !== 'json') throw new Error('Expected structured result');
    expect(Object.keys(leaf.result.schema.properties!)).toEqual(['issues', 'commits']);
  });
  it.each(['plain', 'e2ee'] as const)('retains authored field order through accepted Run storage without changing semantic identity (%s)', (mode) => {
    const definition = { version: 1 as const, inputs: [], defaults: createDeepWorkflowDefinition(0).defaults, blocks: [{ kind: 'step' as const,
      id: 'gather', document: { text: 'Gather changes', references: [], attachments: [] }, input: [],
      execution: { modelSelection: null, permissionMode: 'default' as const },
      result: { kind: 'json' as const, schema: { type: 'object' as const, properties: {
        issues: { type: 'string' as const }, commits: { type: 'string' as const },
      } } },
    }] };
    const reordered = { ...definition, blocks: [{ ...definition.blocks[0]!, result: { kind: 'json' as const,
      schema: { type: 'object' as const, properties: { commits: { type: 'string' as const }, issues: { type: 'string' as const } } },
    } }] };
    expect(deriveWorkflowPlanRunIdV1('run-1', 'row-1', definition))
      .toBe(deriveWorkflowPlanRunIdV1('run-1', 'row-1', reordered));
    const imported = parseWorkflowDocumentV1({ kind: 'happier.workflow', version: 1, definition });
    const fields = (value: typeof imported.definition) => {
      const leaf = value.blocks[0]!;
      if (leaf.kind !== 'step' || leaf.result.kind !== 'json') throw new Error('Expected structured result');
      return Object.keys(leaf.result.schema.properties!);
    };
    expect(fields(imported.definition)).toEqual(['issues', 'commits']);
    const acceptedSnapshot = { startedBy: 'user' as const, authoredDefinition: imported.definition,
      definition: imported.definition, workDepth: 0, metadata: null, materializedLeaves: [], frozenChildren: {},
      inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' as const },
      workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
      source: { kind: 'inline' as const }, origin: { kind: 'direct' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } },
    };
    const envelope = sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ binding: acceptedBinding, acceptedSnapshot,
      ...(mode === 'plain' ? { mode } : { mode, runDataKey, randomBytes }),
    });
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode, binding: acceptedBinding, runDataKey,
      envelope: parseWorkflowStoredContentEnvelopeV1(serializeWorkflowStoredContentEnvelopeV1(envelope)),
    });
    if (opened.kind !== 'available') throw new Error('Expected readable Run');
    expect(fields(opened.content.definition)).toEqual(['issues', 'commits']);
    // Already-stored, key-sorted definitions keep their order; no inferred historical order.
    const stored = parseWorkflowDocumentJsonV1(createCanonicalJsonSigningInput({ kind: 'happier.workflow', version: 1, definition }));
    expect(fields(stored.definition)).toEqual(['commits', 'issues']);
  });
  it('projects retained finite completion addresses while preserving arbitrary Action output JSON', () => {
    const target = { key: 'command', serverId: 'home', machineId: 'worker', operationId: 'finite' };
    const output = { arbitraryFutureOutput: { preserve: true } };
    const execution = { kind: 'action' as const, actionId: 'projects.prepare', actionRequestId: 'request',
      localInputId: 'request', input: {}, output, awaitedOperations: [target] };
    const progress = { kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: 'prepare', scope: [] },
      blockKind: 'action' as const, attempt: '0', logicalInvocationRecordId: 'row-1', execution };
    const envelope = { t: 'plain', v: { v: 2, binding: progressBinding, content: { ...progress,
      execution: { ...execution, future: true, awaitedOperations: [{ ...target, future: true }] } } } };
    expect(openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: progressBinding, envelope }))
      .toEqual({ kind: 'available', content: progress });
    expect(() => sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: progressBinding,
      progress: { ...progress, execution: { ...execution, future: true } } })).toThrow();
  });
  it('opens unknown checkpoint fields without weakening required fields, binding or writes', () => {
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: 'row-1',
      nextSequence: '1', frontier: { nextBlockOrdinal: 1, paused: false } };
    const envelope = { t: 'plain', extra: true, v: { v: 2, extra: true,
      binding: { ...checkpointBinding, extra: true }, content: { ...checkpoint, extra: true,
        frontier: { ...checkpoint.frontier, extra: true } } } };
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain', binding: checkpointBinding, envelope }))
      .toEqual({ kind: 'available', content: checkpoint });
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain', binding: { ...checkpointBinding, runId: 'other-run' }, envelope }))
      .toEqual({ kind: 'bindingMismatch' });
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain', binding: checkpointBinding,
      envelope: { ...envelope, v: { ...envelope.v, content: { ...envelope.v.content, rootRecordId: null } } } }))
      .toEqual({ kind: 'payloadInvalid' });
    const nonCanonicalCheckpoint = { ...checkpoint, frontier: { ...checkpoint.frontier, extra: true } };
    expect(() => sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain', binding: checkpointBinding,
      checkpoint: nonCanonicalCheckpoint }))
      .toThrow();
  });
  it.each(['plain', 'e2ee'] as const)('round-trips final-panel fingerprint under the exact Run binding (%s)', (mode) => {
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: 'row-1',
      nextSequence: '1', frontier: { nextBlockOrdinal: 1, paused: false }, endFingerprint: 'F-b' };
    const envelope = mode === 'plain'
      ? sealWorkflowCheckpointStoredEnvelopeV1({ mode, binding: checkpointBinding, checkpoint })
      : sealWorkflowCheckpointStoredEnvelopeV1({ mode, binding: checkpointBinding, checkpoint, runDataKey, randomBytes });
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode, binding: checkpointBinding, envelope,
      ...(mode === 'e2ee' ? { runDataKey } : {}) })).toEqual({ kind: 'available', content: checkpoint });
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode, binding: { ...checkpointBinding, runId: 'other-run' }, envelope,
      ...(mode === 'e2ee' ? { runDataKey } : {}) }).kind).toBe('bindingMismatch');
  });
  it('refuses pre-cut plain history and never fabricates keys for new plain content', () => {
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: 'row-1',
      nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain', binding: checkpointBinding,
      envelope: { t: 'plain', v: { v: 1, binding: checkpointBinding, content: checkpoint } },
    })).toEqual({ kind: 'payloadInvalid' });
    const envelope = sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain', binding: checkpointBinding, checkpoint });
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain', binding: checkpointBinding, envelope }))
      .toEqual({ kind: 'available', content: checkpoint });
  });
  it('opens only with the run key and authenticates owner binding', () => {
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: 'row-1',
      nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
    const envelope = sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'e2ee', binding: checkpointBinding,
      checkpoint, runDataKey, randomBytes });
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode: 'e2ee', binding: checkpointBinding, envelope }))
      .toEqual({ kind: 'materialUnavailable' });
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode: 'e2ee', binding: checkpointBinding, envelope,
      runDataKey: new Uint8Array(32).fill(9) })).toEqual({ kind: 'contentInvalid' });
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode: 'e2ee', binding: { ...checkpointBinding, accountId: 'viewer' },
      envelope, runDataKey })).toEqual({ kind: 'bindingMismatch' });
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain', binding: checkpointBinding, envelope }))
      .toEqual({ kind: 'modeMismatch' });
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode: 'e2ee', binding: checkpointBinding, envelope,
      runDataKey: new Uint8Array(31) })).toEqual({ kind: 'contentInvalid' });
    // Outer validation cannot authenticate the inner binding or require keys,
    // and must not expose the decoded bytes retained privately by the opener.
    expect(validateWorkflowStoredEnvelopeOuterForModeV1({ mode: 'e2ee', binding: checkpointBinding, envelope }))
      .toEqual({ kind: 'available', envelope });
    if (envelope.t !== 'encrypted') throw new Error('Expected encrypted checkpoint');
    for (const c of ['wfr1:AAAA', `${envelope.c}=`, `${envelope.c}\n`, envelope.c.replace('wfr1:', 'legacy:')]) {
      const malformed = { t: 'encrypted', c };
      expect(validateWorkflowStoredEnvelopeOuterForModeV1({ mode: 'e2ee', binding: checkpointBinding, envelope: malformed }))
        .toEqual({ kind: 'contentInvalid' });
      // Malformed content wins over missing material, as before the optimization.
      expect(openWorkflowCheckpointStoredEnvelopeV1({ mode: 'e2ee', binding: checkpointBinding, envelope: malformed }))
        .toEqual({ kind: 'contentInvalid' });
    }
  });
  it('refuses pre-cut Account-derived workflow ciphertext without fallback', () => {
    const envelope = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
      kind: 'workflow_checkpoint', material, randomBytes,
      payload: { v: 1, binding: checkpointBinding, content: {
        kind: 'happier.workflow-checkpoint.v1', rootRecordId: 'row-1', nextSequence: '1',
        frontier: { nextBlockOrdinal: 0, paused: false },
      } },
    }) };
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode: 'e2ee', binding: checkpointBinding,
      envelope, runDataKey: new Uint8Array(32).fill(7),
    }).kind).toBe('contentInvalid');
  });
  it('seals and opens a deep accepted definition in plain and E2EE modes', () => {
    const definition = createDeepWorkflowDefinition();
    const acceptedSnapshot = {
      startedBy: 'user' as const,
      authoredDefinition: definition, workDepth: 0, metadata: null,
      materializedLeaves: [], frozenChildren: {},
      definition, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' as const },
      workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
      source: { kind: 'inline' as const }, origin: { kind: 'direct' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } },
    };
    for (const mode of ['plain', 'e2ee'] as const) {
      const envelope = sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        binding: acceptedBinding, acceptedSnapshot,
        ...(mode === 'plain' ? { mode } : { mode, runDataKey, randomBytes }),
      });
      const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode, binding: acceptedBinding, envelope, runDataKey });
      expect(opened.kind).toBe('available');
      if (opened.kind !== 'available') throw new Error('expected accepted snapshot');
      expect(sameStrictJsonValue(opened.content.definition, definition)).toBe(true);
    }
  });
  it.each(['plain', 'e2ee'] as const)('admits every canonical purpose once per stored open (%s)', (mode) => {
    const definition = { version: 1 as const, inputs: [], defaults: {}, blocks: [{ kind: 'step' as const,
      id: 'step-1', document: { text: 'Do it', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } }] };
    const fixtures = [
      {
        schema: WorkflowAcceptedSnapshotV1Schema,
        seal: (mode: 'plain' | 'e2ee') => sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
          binding: acceptedBinding,
          acceptedSnapshot: {
            startedBy: 'trigger',
            definition, authoredDefinition: definition, workDepth: 0,
            materializedLeaves: [], frozenChildren: {},
            metadata: { title: 'Frozen private title', description: 'Frozen private summary' },
            inputs: {},
            machineId: 'machine-1',
            executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
            source: { kind: 'automation', automationId: 'automation-1' },
            authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
          },
          ...(mode === 'plain' ? { mode } : { mode, runDataKey, randomBytes }),
        }),
        open: (mode: 'plain' | 'e2ee', envelope: unknown) => openWorkflowAcceptedSnapshotStoredEnvelopeV1({
          mode, binding: acceptedBinding, envelope, runDataKey,
        }),
      },
      {
        schema: WorkflowProgressEnvelopeV1Schema,
        seal: (mode: 'plain' | 'e2ee') => sealWorkflowProgressStoredEnvelopeV1({
          binding: progressBinding,
          progress: {
            kind: 'happier.workflow-progress.v1',
            invocationPath: { blockId: '$root', scope: [] },
            blockKind: 'root',
            attempt: '0',
            logicalInvocationRecordId: 'row-1',
          },
          ...(mode === 'plain' ? { mode } : { mode, runDataKey, randomBytes }),
        }),
        open: (mode: 'plain' | 'e2ee', envelope: unknown) => openWorkflowProgressStoredEnvelopeV1({
          mode, binding: progressBinding, envelope, runDataKey,
        }),
      },
      {
        schema: WorkflowCheckpointEnvelopeV1Schema,
        seal: (mode: 'plain' | 'e2ee') => sealWorkflowCheckpointStoredEnvelopeV1({
          binding: checkpointBinding,
          checkpoint: {
            kind: 'happier.workflow-checkpoint.v1',
            rootRecordId: 'row-1',
            nextSequence: '1',
            frontier: { nextBlockOrdinal: 1, paused: false },
          },
          ...(mode === 'plain' ? { mode } : { mode, runDataKey, randomBytes }),
        }),
        open: (mode: 'plain' | 'e2ee', envelope: unknown) => openWorkflowCheckpointStoredEnvelopeV1({
          mode, binding: checkpointBinding, envelope, runDataKey,
        }),
      },
      {
        schema: WorkflowFinalResultV1Schema,
        seal: (mode: 'plain' | 'e2ee') => sealWorkflowFinalResultStoredEnvelopeV1({
          binding: finalResultBinding,
          finalResult: {
            kind: 'happier.workflow-final-result.v1',
            result: { kind: 'text', value: 'done' },
            producerInvocation: { recordId: 'row-1' },
          },
          ...(mode === 'plain' ? { mode } : { mode, runDataKey, randomBytes }),
        }),
        open: (mode: 'plain' | 'e2ee', envelope: unknown) => openWorkflowFinalResultStoredEnvelopeV1({
          mode, binding: finalResultBinding, envelope, runDataKey,
        }),
      },
    ];

    for (const fixture of fixtures) {
      const envelope = parseWorkflowStoredContentEnvelopeV1(serializeWorkflowStoredContentEnvelopeV1(fixture.seal(mode)));
      // Observe the real parser without replacing any internal admission logic.
      const admissions = vi.spyOn(createStoredReadSchema(fixture.schema)._zod, 'run');
      try {
        expect(fixture.open(mode, envelope).kind).toBe('available');
        expect(admissions).toHaveBeenCalledTimes(1);
      } finally {
        admissions.mockRestore();
      }
    }
  });

  it.each(['plain', 'e2ee'] as const)('refuses a public opener mis-wired to another admitted purpose (%s)', (mode) => {
    const envelope = sealWorkflowCheckpointStoredEnvelopeV1({
      binding: checkpointBinding,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: 'row-1', nextSequence: '1',
        frontier: { nextBlockOrdinal: 1, paused: false } },
      ...(mode === 'plain' ? { mode } : { mode, runDataKey, randomBytes }),
    });
    // JavaScript/foreign callers can mis-bind despite the TypeScript signature.
    for (const open of [openWorkflowAcceptedSnapshotStoredEnvelopeV1, openWorkflowProgressStoredEnvelopeV1,
      openWorkflowFinalResultStoredEnvelopeV1]) {
      expect(Reflect.apply(open, undefined, [{ mode, binding: checkpointBinding, envelope, runDataKey }]))
        .toEqual({ kind: 'contentInvalid' });
    }
    const finalEnvelope = sealWorkflowFinalResultStoredEnvelopeV1({
      binding: finalResultBinding,
      finalResult: { kind: 'happier.workflow-final-result.v1', result: { kind: 'text', value: 'done' },
        producerInvocation: { recordId: 'row-1' } },
      ...(mode === 'plain' ? { mode } : { mode, runDataKey, randomBytes }),
    });
    expect(Reflect.apply(openWorkflowCheckpointStoredEnvelopeV1, undefined,
      [{ mode, binding: finalResultBinding, envelope: finalEnvelope, runDataKey }]))
      .toEqual({ kind: 'contentInvalid' });
  });

  it.each(['plain', 'e2ee'] as const)('refuses malformed content inside an untrusted stored payload (%s)', (mode) => {
    const valid = sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain', binding: checkpointBinding,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: 'row-1', nextSequence: '1',
        frontier: { nextBlockOrdinal: 1, paused: false } } });
    if (valid.t !== 'plain' || typeof valid.v !== 'object' || valid.v === null || Array.isArray(valid.v)) {
      throw new Error('Expected plain payload');
    }
    const content = { kind: 'happier.workflow-checkpoint.v1', rootRecordId: null, nextSequence: '1',
      frontier: { nextBlockOrdinal: 1, paused: false } };
    const payload = { ...valid.v, content };
    // Corrupt storage must bypass the canonical writer, which rejects this content.
    const nonce = randomBytes(tweetnacl.secretbox.nonceLength);
    const ciphertext = tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(payload)), nonce, runDataKey);
    const envelope = mode === 'plain' ? { t: 'plain', v: payload }
      : { t: 'encrypted', c: `wfr1:${encodeBase64(new Uint8Array([...nonce, ...ciphertext]))}` };
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode, binding: checkpointBinding, envelope, runDataKey }))
      .toEqual({ kind: 'payloadInvalid' });
  });

  it('fails a private accepted metadata open closed with the wrong E2EE material', () => {
    const definition = { version: 1 as const, inputs: [], defaults: {}, blocks: [{ kind: 'step' as const,
      id: 'step-1', document: { text: 'Do it', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } }] };
    const envelope = sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'e2ee', binding: acceptedBinding, runDataKey, randomBytes,
      acceptedSnapshot: {
        startedBy: 'trigger', definition, authoredDefinition: definition, workDepth: 0,
        materializedLeaves: [], frozenChildren: {},
        metadata: { title: 'Secret title' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        source: { kind: 'automation', automationId: 'automation-1' },
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      },
    });
    expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'e2ee', binding: acceptedBinding, envelope,
      runDataKey: new Uint8Array(32).fill(8),
    })).toMatchObject({ kind: 'contentInvalid' });
  });

  it('binds a retry envelope to its physical row while retaining the first attempt as logical identity', () => {
    const retryBinding = {
      ...progressBinding,
      recordId: 'row-2',
      sequence: '1',
      parentRecordId: 'row-root',
      attempt: '1',
    };
    const envelope = sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: retryBinding,
      progress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'step-1', scope: [] },
        blockKind: 'step',
        attempt: '1',
        logicalInvocationRecordId: 'row-1',
        previousAttemptRecordId: 'row-1',
      },
    });

    expect(openWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: retryBinding,
      envelope,
    })).toMatchObject({
      kind: 'available',
      content: {
        logicalInvocationRecordId: 'row-1',
        previousAttemptRecordId: 'row-1',
      },
    });
  });

  it('binds the private execution attempt to the immutable row selector', () => {
    expect(() => sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: progressBinding,
      progress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'step-1', scope: [] },
        blockKind: 'step',
        attempt: '1',
        logicalInvocationRecordId: 'row-0',
        previousAttemptRecordId: 'row-0',
      },
    })).toThrow(TypeError);
  });

  it('fails closed for mode, row, Run and purpose replay', () => {
    const encryptedProgress = sealWorkflowProgressStoredEnvelopeV1({
      mode: 'e2ee', runDataKey, randomBytes, binding: progressBinding,
      progress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: 'row-1',
      },
    });
    expect(openWorkflowProgressStoredEnvelopeV1({
      mode: 'e2ee', runDataKey, envelope: encryptedProgress,
      binding: { ...progressBinding, recordId: 'row-2' },
    })).toEqual({ kind: 'bindingMismatch' });
    expect(openWorkflowProgressStoredEnvelopeV1({
      mode: 'e2ee', runDataKey, envelope: encryptedProgress,
      binding: { ...progressBinding, runId: 'run-2' },
    })).toEqual({ kind: 'bindingMismatch' });
    expect(openWorkflowFinalResultStoredEnvelopeV1({
      mode: 'e2ee', runDataKey, envelope: encryptedProgress, binding: finalResultBinding,
    })).toEqual({ kind: 'payloadInvalid' });
    expect(validateWorkflowStoredEnvelopeOuterForModeV1({
      mode: 'plain', envelope: encryptedProgress, binding: progressBinding,
    })).toEqual({ kind: 'modeMismatch' });
  });
});

import { describe, expect, it } from 'vitest';

import type { AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';
import { createDeepWorkflowDefinition } from './workflowDefinition.testkit.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import {
  openWorkflowAcceptedSnapshotStoredEnvelopeV1,
  openWorkflowCheckpointStoredEnvelopeV1,
  openWorkflowFinalResultStoredEnvelopeV1,
  openWorkflowProgressStoredEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowFinalResultStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  validateWorkflowStoredEnvelopeOuterForModeV1,
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
      .toEqual({ kind: 'contentInvalid' });
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
    })).toEqual({ kind: 'contentInvalid' });
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
  it('round-trips every canonical purpose in plain and E2EE modes', () => {
    const definition = { version: 1 as const, inputs: [], defaults: {}, blocks: [{ kind: 'step' as const,
      id: 'step-1', document: { text: 'Do it', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } }] };
    const fixtures = [
      {
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
      expect(fixture.open('plain', fixture.seal('plain')).kind).toBe('available');
      expect(fixture.open('e2ee', fixture.seal('e2ee')).kind).toBe('available');
    }
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
    })).toEqual({ kind: 'contentInvalid' });
    expect(validateWorkflowStoredEnvelopeOuterForModeV1({
      mode: 'plain', envelope: encryptedProgress, binding: progressBinding,
    })).toEqual({ kind: 'modeMismatch' });
  });
});

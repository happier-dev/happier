import { describe, expect, it } from 'vitest';

import {
  defineProtocolLiteral,
  defineProtocolObject,
} from '../actions/protocolComposableSchema.js';
import {
  COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
  ComposerControlStateV1Schema,
  ComposerControlStateContentTypeV1Schema,
  ComposerDecorationSetV1Schema,
  ComposerOperationV1Schema,
  ComposerRefV1Schema,
  ComposerSnapshotV1Schema,
  ComposerSurfaceMountBindingV1Schema,
  ComposerSurfaceInputV1Schema,
  ComposerTransactionV1Schema,
  isComposerControlStateContentTypeV1,
} from './composer.js';
import type {
  ComposerRefV1,
  ComposerSnapshotV1,
  ComposerTransactionV1,
} from './composer.js';
import type {
  ComposerAttachmentAuthorValueV1,
  ComposerAttachmentValueV1,
  ComposerAttachmentViewV1,
} from '../../runtime/input/composerAttachmentV1.js';

const composer = { kind: 'session', sessionId: 'session-1' } as const;

const stagedMediaContent = {
  kind: 'stagedMedia',
  handle: {
    v: 1,
    id: 'stage-1',
    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
    owner: { pluginId: 'com.acme.review', localId: 'review' },
    mediaKind: 'image',
    mimeType: 'image/png',
    name: 'review.png',
    sizeBytes: 42,
    sha256: 'a'.repeat(64),
  },
} as const;

/**
 * Public Composer values are observations and transaction descriptions, not
 * caller-owned state. Keep this compile fixture at the Protocol owner so a
 * mutable schema inference cannot reopen the wire contract unnoticed.
 */
function assertComposerPublicValuesAreReadonly(
  current: Readonly<{ ref: Extract<ComposerRefV1, { kind: 'session' }> }>,
  snapshot: ComposerSnapshotV1,
  transaction: ComposerTransactionV1,
): void {
  // @ts-expect-error -- a public Composer handle cannot retarget its exact scope.
  current.ref.sessionId = 'different-session';
  // @ts-expect-error -- a snapshot attachment list is observed, not caller-owned.
  snapshot.attachments.push();
  // @ts-expect-error -- a transaction's operation list is fixed once supplied.
  transaction.operations = [];
}

void assertComposerPublicValuesAreReadonly;

/**
 * Attachment values are also re-exported by the Protocol root and reach the
 * Composer public graph directly. Keep them readonly at their existing owner.
 */
function assertComposerAttachmentPublicValuesAreReadonly(
  attachment: ComposerAttachmentViewV1,
  authorValue: ComposerAttachmentAuthorValueV1,
  value: Extract<ComposerAttachmentValueV1, readonly unknown[]>,
): void {
  // @ts-expect-error -- an observed attachment presentation cannot be retitled in place.
  attachment.presentation.typeLabel = 'different-type';
  // @ts-expect-error -- an author value's nested presentation is not mutable after construction.
  authorValue.presentation.label = 'different-label';
  // @ts-expect-error -- arbitrary JSON attachment arrays are readonly public values too.
  value.push('different-value');
}

void assertComposerAttachmentPublicValuesAreReadonly;

describe('Composer protocol surface', () => {
  it('owns the exact media type for a Resource-derived control-state document', () => {
    expect(COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1)
      .toBe('application/vnd.happier.composer-control-state+json;v=1');
    expect(ComposerControlStateContentTypeV1Schema.safeParse(
      COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
    ).success).toBe(true);
    for (const nonCanonical of [
      'application/json',
      `${COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1};charset=utf-8`,
      'Application/vnd.happier.composer-control-state+json;v=1',
    ]) {
      expect(isComposerControlStateContentTypeV1(nonCanonical)).toBe(false);
    }
  });

  it('rejects lossy whitespace around Resource-selected choice identities', () => {
    expect(ComposerControlStateV1Schema.safeParse({
      selectedChoiceIds: [' issue-42 '],
    }).success).toBe(false);
    expect(ComposerControlStateV1Schema.parse({
      selectedChoiceIds: ['issue-42'],
    })).toEqual({
      selectedChoiceIds: ['issue-42'],
    });
  });

  it('keeps the live composer scope union closed', () => {
    expect(ComposerRefV1Schema.safeParse(composer).success).toBe(true);
    expect(ComposerRefV1Schema.safeParse({ kind: 'sideChat', sessionId: 'session-1' }).success).toBe(false);
    expect(ComposerRefV1Schema.safeParse({ kind: 'session', sessionId: ' session-1 ' }).success).toBe(false);
  });

  it('publishes the live composer scope as a validator-neutral composable a feature protocol can embed', () => {
    // A feature protocol declares its own closed launch input through the
    // public composition algebra. Embedding this canonical scope must compose
    // structurally and carry its constraints into the published JSON Schema —
    // a validator-specific value degrades its members instead.
    const launchInput = defineProtocolObject({
      v: defineProtocolLiteral(1),
      originComposer: ComposerRefV1Schema.optional(),
    }, { policy: 'closed' });

    expect(launchInput.parse({ v: 1, originComposer: composer })).toEqual({ v: 1, originComposer: composer });
    expect(launchInput.parse({ v: 1 })).toEqual({ v: 1 });
    for (const malformed of [
      { kind: 'session' },
      { kind: 'session', sessionId: 'session-1', instanceId: 'instance-1' },
      { kind: 'sideChat', sessionId: 'session-1' },
      { kind: 'pendingMessage', sessionId: 'session-1' },
      { kind: 'newSession', instanceId: ' instance-1 ' },
    ]) {
      expect(launchInput.safeParse({ v: 1, originComposer: malformed }).success).toBe(false);
    }

    const projected = launchInput.jsonSchema.properties?.originComposer;
    expect(projected?.anyOf?.length).toBe(5);
    expect(projected?.anyOf?.[0]?.properties?.sessionId?.type).toBe('string');
  });

  it('keeps Composer references range-bound and distinct from persisted structured mentions', () => {
    const reference = {
      kind: 'happier.file',
      ref: 'file:src/index.ts',
      token: '@src/index.ts',
      start: 0,
      end: 13,
      composerReference: { pluginId: 'acme.issues', localId: 'issues' },
    };
    const snapshot = {
      revision: 1,
      ref: composer,
      text: '@src/index.ts',
      references: [reference],
      attachments: [],
      layout: 'wrap',
      capabilities: { text: true, references: true, attachments: true, submit: true },
      state: { focused: true, editable: true, submittable: true, submitting: false, running: false },
    };

    expect(ComposerOperationV1Schema.parse({
      kind: 'reference.insert',
      reference,
    }).reference).toEqual(reference);
    expect(ComposerSnapshotV1Schema.parse(snapshot).references).toEqual([reference]);
    const { composerReference: _composerReference, ...referenceWithoutCompanion } = reference;
    expect(ComposerOperationV1Schema.safeParse({
      kind: 'reference.insert',
      reference: referenceWithoutCompanion,
    }).success).toBe(true);

    const positionlessReference = {
      kind: reference.kind,
      ref: reference.ref,
      token: reference.token,
    };
    expect(ComposerOperationV1Schema.safeParse({
      kind: 'reference.insert',
      reference: positionlessReference,
    }).success).toBe(false);
    expect(ComposerSnapshotV1Schema.safeParse({
      ...snapshot,
      references: [positionlessReference],
    }).success).toBe(false);
    expect(ComposerOperationV1Schema.safeParse({
      kind: 'reference.insert',
      reference: { ...reference, futureField: true },
    }).success).toBe(false);
    expect(ComposerOperationV1Schema.safeParse({
      kind: 'reference.insert',
      reference: { ...reference, ref: 'not-a-reference' },
    }).success).toBe(false);
    expect(ComposerOperationV1Schema.safeParse({
      kind: 'reference.insert',
      reference: { ...reference, start: 13, end: 13 },
    }).success).toBe(false);
    expect(ComposerOperationV1Schema.safeParse({
      kind: 'reference.insert',
      reference: {
        ...reference,
        composerReference: { pluginId: 'not a plugin id', localId: 'issues' },
      },
    }).success).toBe(false);
  });

  it('keeps attachment picker input plugin-owned and free of per-instance focus state', () => {
    const picker = {
      v: 1,
      role: 'attachmentPicker',
      composer,
      attachmentLocalId: 'review',
      instances: [{
        v: 1,
        instanceId: 'instance-1',
        attachment: {
          pluginId: 'com.acme.review',
          localId: 'review',
        },
        key: 'review-42',
        value: { reviewId: '42' },
        presentation: { label: 'Review #42', typeLabel: 'Review comment' },
        availability: { status: 'ready' },
      }],
    };

    expect(ComposerSurfaceInputV1Schema.safeParse(picker).success).toBe(true);
    expect(ComposerSurfaceInputV1Schema.safeParse({
      ...picker,
      instances: [{
        ...picker.instances[0],
        attachment: {
          kind: 'plugin',
          contribution: { pluginId: 'com.acme.review', localId: 'review' },
        },
      }],
    }).success).toBe(false);
    expect(ComposerSurfaceInputV1Schema.safeParse({ ...picker, focusInstanceId: 'instance-1' }).success).toBe(false);
    expect(ComposerSurfaceInputV1Schema.safeParse({
      ...picker,
      instances: [{
        ...picker.instances[0],
        attachment: { kind: 'host', owner: 'reviewComments' },
      }],
    }).success).toBe(false);
    expect(ComposerSurfaceInputV1Schema.safeParse({
      v: 1,
      role: 'region',
      composer,
      regionLocalId: 'context',
      focusInstanceId: 'instance-1',
    }).success).toBe(false);
  });

  it('never projects a host Review attachment into a plugin preview surface', () => {
    expect(ComposerSurfaceInputV1Schema.safeParse({
      v: 1,
      role: 'attachmentPreview',
      composer,
      attachmentLocalId: 'review',
      instance: {
        v: 1,
        instanceId: 'review-comment-42',
        attachment: { kind: 'host', owner: 'reviewComments' },
        key: 'review-42',
        value: { reviewId: '42' },
        presentation: { label: 'Review #42', typeLabel: 'Review comment' },
        availability: { status: 'ready' },
      },
    }).success).toBe(false);
  });

  it('admits one closed, generation-fenced composer mount and rejects a mismatched role or contributor', () => {
    const mount = {
      kind: 'composer',
      contribution: { pluginId: 'com.acme.review', localId: 'review' },
      immutableGenerationId: 'review-generation-1',
      projectionGeneration: 4,
      role: 'attachmentPreview',
      selectedRenderer: { pluginId: 'com.acme.review', localId: 'review-preview' },
      rendererChain: [{ pluginId: 'com.acme.review', localId: 'review-preview' }],
      composer,
      instanceKey: 'review-preview:instance-1',
      input: {
        v: 1,
        role: 'attachmentPreview',
        composer,
        attachmentLocalId: 'review',
        instance: {
          v: 1,
          instanceId: 'instance-1',
          attachment: { pluginId: 'com.acme.review', localId: 'review' },
          key: 'review-42',
          value: { reviewId: '42' },
          presentation: { label: 'Review #42', typeLabel: 'Review comment' },
          availability: { status: 'ready' },
        },
      },
    } as const;

    expect(ComposerSurfaceMountBindingV1Schema.safeParse(mount).success).toBe(true);
    expect(ComposerSurfaceMountBindingV1Schema.safeParse({
      ...mount,
      role: 'region',
    }).success).toBe(false);
    expect(ComposerSurfaceMountBindingV1Schema.safeParse({
      ...mount,
      selectedRenderer: { pluginId: 'com.acme.other', localId: 'review-preview' },
    }).success).toBe(false);
  });

  it('allows authors to add only a caller-local plugin attachment, never a host identity', () => {
    const transaction = {
      expectedRevision: 4,
      operations: [{
        kind: 'attachment.add',
        attachmentLocalId: 'review',
        value: {
          key: 'review-42',
          value: { reviewId: '42' },
          presentation: { label: 'Review #42' },
        },
      }],
    };

    expect(ComposerTransactionV1Schema.safeParse(transaction).success).toBe(true);
    expect(ComposerTransactionV1Schema.safeParse({
      ...transaction,
      operations: [{
        kind: 'attachment.add',
        attachment: { kind: 'host', owner: 'reviewComments' },
        value: transaction.operations[0]?.value,
      }],
    }).success).toBe(false);
  });

  it('carries only staged media through attachment creation, leaving durable media to admission', () => {
    const operation = {
      kind: 'attachment.add',
      attachmentLocalId: 'review',
      value: {
        key: 'review-42',
        value: { reviewId: '42' },
        presentation: { label: 'Review #42' },
      },
      content: stagedMediaContent,
    } as const;

    expect(ComposerOperationV1Schema.safeParse(operation).success).toBe(true);
    expect(ComposerOperationV1Schema.safeParse({
      ...operation,
      content: { kind: 'sessionMedia', mediaId: 'media-1' },
    }).success).toBe(false);
    expect(ComposerOperationV1Schema.safeParse({
      ...operation,
      value: { ...operation.value, content: stagedMediaContent },
    }).success).toBe(false);
  });

  it('keeps a decoration set revision singular and strict', () => {
    expect(ComposerDecorationSetV1Schema.parse({
      revision: 4,
      ranges: [{
        range: { start: 0, end: 1 },
        treatment: 'highlight',
      }],
    })).toEqual({
      revision: 4,
      ranges: [{
        range: { start: 0, end: 1 },
        treatment: 'highlight',
      }],
    });
    expect(ComposerDecorationSetV1Schema.safeParse({
      revision: 4,
      ranges: [],
      duplicateRevision: 4,
    }).success).toBe(false);
  });
});

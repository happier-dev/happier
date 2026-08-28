import { describe, expect, it } from 'vitest';

import type { AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import {
  createReviewCommentLinkedIssueIdV1,
  type ReviewCommentEventV1,
  type ReviewCommentV1,
} from './v1.js';
import {
  bindReviewCommentEventSensitiveEnvelopeV1,
  buildReviewCommentEventRequestBindingV1,
  buildReviewCommentMutationEventEnvelopeV1,
  classifyReviewCommentEventSensitiveMigrationLayoutV1,
  openReviewCommentSensitiveMigrationSourceV1,
  openReviewCommentSensitiveEnvelopeV1,
  openReviewCommentEventSensitiveEnvelopeV1,
  openStoredReviewCommentV1,
  ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema,
  ReviewCommentSensitiveMigrationSourceV1Schema,
  sealReviewCommentSensitiveEnvelopeV1,
  sealReviewCommentEventSensitiveEnvelopeV1,
  splitReviewCommentV1,
} from './content.js';

const MATERIAL: AccountScopedCryptoMaterial = {
  type: 'dataKey',
  machineKey: new Uint8Array(32).fill(7),
};

const OTHER_MATERIAL: AccountScopedCryptoMaterial = {
  type: 'dataKey',
  machineKey: new Uint8Array(32).fill(8),
};

function comment(overrides: Partial<ReviewCommentV1> = {}): ReviewCommentV1 {
  return {
    v: 1,
    id: 'comment-1',
    accountId: 'account-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    anchor: {
      kind: 'line',
      filePath: 'src/private.ts',
      line: 14,
      side: 'after',
    },
    snapshot: {
      kind: 'text',
      selectedLines: ['const secret = true;'],
      beforeContext: ['function run() {'],
      afterContext: ['}'],
      selectedLinesHash: 'selected-hash',
      contextWindowHash: 'context-hash',
      capturedAt: 1_000,
      fileLength: 3,
      source: 'workingTree',
      isUncommitted: true,
      isUntracked: false,
      truncated: false,
      hasBidiControls: false,
      likelyMinified: false,
    },
    body: 'Please avoid exposing this value.',
    bodyVersion: 1,
    edits: [],
    author: { kind: 'user', userId: 'user-1' },
    state: 'open',
    flags: {},
    dispositions: {},
    threadId: 'comment-1',
    evidence: [{ kind: 'reasoning', message: 'Repository-private rationale' }],
    transitions: [{
      transitionId: 'transition-1',
      toState: 'open',
      transitionedAt: 1_001,
      transitionedBy: { kind: 'user', userId: 'user-1' },
      reason: 'Needs attention',
      serverRevision: 1,
    }],
    fingerprint: {
      normalizedMessageHash: 'dedupe-hash',
      ruleId: 'private-rule',
    },
    linkedRefs: [{
      kind: 'issue',
      id: createReviewCommentLinkedIssueIdV1({
        source: { pluginId: 'happier.scm.github', localId: 'github' },
        kindId: 'issue',
        collisionScope: 'github:example/repository',
        entryId: '42',
      }),
      url: 'https://github.com/example/repository/issues/42',
    }],
    suggestedFix: {
      kind: 'replacement',
      replacementText: 'const secret = false;',
    },
    metadata: {
      severity: 'error',
      taxonomyIds: ['security.secret'],
      tags: ['private'],
    },
    createdAt: 1_001,
    updatedAt: 1_001,
    serverRevision: 1,
    ...overrides,
  };
}

function event(overrides: Partial<ReviewCommentEventV1> = {}): ReviewCommentEventV1 {
  return {
    eventId: 'event-1',
    commentId: 'comment-1',
    accountId: 'account-1',
    projectId: 'project-1',
    eventKind: 'edited',
    actor: { kind: 'user', userId: 'user-1' },
    createdAt: 2_000,
    serverRevision: 2,
    authorDeviceId: 'device-1',
    clientLamport: 3,
    event: {
      clientMutationId: 'mutation-1',
      reason: 'Repository-private edit reason',
    },
    ...overrides,
  };
}

describe('Review Comment structural/sensitive content', () => {
  it('parses a provenance-scoped legacy split migration source without pretending it is one ciphertext', () => {
    const source = comment();
    expect(ReviewCommentSensitiveMigrationSourceV1Schema.parse({
      v: 1,
      layout: 'legacy_split_v1',
      sourceMode: 'e2ee',
      anchor: source.anchor,
      snapshotEnvelope: { t: 'encrypted', c: 'snapshot-ciphertext' },
      bodyEnvelope: { t: 'encrypted', c: 'body-ciphertext' },
      edits: source.edits,
      evidence: source.evidence,
      transitions: source.transitions,
      fingerprint: source.fingerprint,
      suggestedFix: source.suggestedFix,
      metadata: source.metadata,
    })).toMatchObject({
      layout: 'legacy_split_v1',
      sourceMode: 'e2ee',
      snapshotEnvelope: { t: 'encrypted', c: 'snapshot-ciphertext' },
      bodyEnvelope: { t: 'encrypted', c: 'body-ciphertext' },
    });
    expect(ReviewCommentSensitiveMigrationSourceV1Schema.safeParse({
      v: 1,
      layout: 'legacy_split_v1',
      sourceMode: 'e2ee',
      anchor: source.anchor,
      snapshotEnvelope: { t: 'encrypted', c: 'snapshot-ciphertext' },
      bodyEnvelope: { t: 'plain', v: source.body },
      edits: source.edits,
      transitions: source.transitions,
    }).success).toBe(false);
    expect(ReviewCommentSensitiveMigrationSourceV1Schema.safeParse({
      v: 1,
      layout: 'legacy_split_v1',
      sourceMode: 'e2ee',
      anchor: source.anchor,
      snapshotEnvelope: { t: 'encrypted', c: 'snapshot-ciphertext' },
      bodyEnvelope: { t: 'encrypted', c: 'body-ciphertext' },
      edits: [{
        editId: 'edit-1',
        editedAt: 1_001,
        editedBy: source.author,
        previousBody: { t: 'encrypted', c: 'previous-ciphertext' },
        nextBody: 'mixed-mode plaintext',
      }],
      transitions: source.transitions,
    }).success).toBe(false);
  });

  it('opens a legacy split source only through its explicit component provenance', async () => {
    const source = comment({
      body: 'updated private body',
      edits: [{
        editId: 'edit-1',
        editedAt: 1_001,
        editedBy: { kind: 'user', userId: 'user-1' },
        previousBody: 'Please avoid exposing this value.',
        nextBody: 'updated private body',
        reason: 'Repository-private edit reason',
      }],
    });
    const split = splitReviewCommentV1(source);
    const migrationSource = ReviewCommentSensitiveMigrationSourceV1Schema.parse({
      v: 1,
      layout: 'legacy_split_v1',
      sourceMode: 'e2ee',
      anchor: source.anchor,
      snapshotEnvelope: { t: 'encrypted', c: 'legacy-snapshot' },
      bodyEnvelope: { t: 'encrypted', c: 'legacy-body' },
      edits: [{
        ...source.edits[0]!,
        previousBody: { t: 'encrypted', c: 'legacy-previous-body' },
        nextBody: { t: 'encrypted', c: 'legacy-next-body' },
      }],
      evidence: source.evidence,
      transitions: source.transitions,
      fingerprint: source.fingerprint,
      suggestedFix: source.suggestedFix,
      metadata: source.metadata,
    });

    await expect(openReviewCommentSensitiveMigrationSourceV1({
      structural: split.structural,
      source: migrationSource,
      openLegacyCiphertext: async (ciphertext) => {
        if (ciphertext === 'legacy-snapshot') return source.snapshot;
        if (ciphertext === 'legacy-body') return source.body;
        if (ciphertext === 'legacy-previous-body') {
          return source.edits[0]!.previousBody;
        }
        if (ciphertext === 'legacy-next-body') {
          return source.edits[0]!.nextBody;
        }
        return null;
      },
    })).resolves.toEqual({ status: 'available', comment: source });
    await expect(openReviewCommentSensitiveMigrationSourceV1({
      structural: split.structural,
      source: migrationSource,
    })).resolves.toEqual({
      status: 'locked',
      reason: 'encryption_material_unavailable',
      structural: split.structural,
      source: migrationSource,
    });
  });

  it('keeps only bounded query/currentness facts in the structural projection', () => {
    const split = splitReviewCommentV1(comment());

    expect(split.structural).toMatchObject({
      id: 'comment-1',
      accountId: 'account-1',
      projectId: 'project-1',
      anchorIndex: {
        kind: 'line',
        filePath: 'src/private.ts',
      },
      bodyVersion: 1,
      serverRevision: 1,
    });
    expect(JSON.stringify(split.structural)).not.toContain('Please avoid exposing');
    expect(JSON.stringify(split.structural)).not.toContain('const secret');
    expect(JSON.stringify(split.structural)).not.toContain('private-rule');
    expect(JSON.stringify(split.structural)).not.toContain('security.secret');
    expect(JSON.stringify(split.structural)).not.toContain('Repository-private');
    expect(JSON.stringify(split.structural)).not.toContain('github:example/repository');
  });

  it('round-trips plain and E2EE sensitive content through the canonical owner', () => {
    const source = comment();
    const split = splitReviewCommentV1(source);
    const plain = sealReviewCommentSensitiveEnvelopeV1({
      structural: split.structural,
      sensitive: split.sensitive,
      mode: 'plain',
    });
    const encrypted = sealReviewCommentSensitiveEnvelopeV1({
      structural: split.structural,
      sensitive: split.sensitive,
      mode: 'e2ee',
      material: MATERIAL,
      randomBytes: (length) => new Uint8Array(length).fill(11),
    });

    expect(plain.t).toBe('plain');
    expect(encrypted.t).toBe('encrypted');
    expect(openReviewCommentSensitiveEnvelopeV1({
      structural: split.structural,
      envelope: plain,
      mode: 'plain',
    })).toEqual({ status: 'available', comment: source });
    expect(openReviewCommentSensitiveEnvelopeV1({
      structural: split.structural,
      envelope: encrypted,
      mode: 'e2ee',
      material: MATERIAL,
    })).toEqual({ status: 'available', comment: source });
  });

  it('preserves ciphertext and structural position when material is missing or wrong', () => {
    const split = splitReviewCommentV1(comment());
    const encrypted = sealReviewCommentSensitiveEnvelopeV1({
      structural: split.structural,
      sensitive: split.sensitive,
      mode: 'e2ee',
      material: MATERIAL,
      randomBytes: (length) => new Uint8Array(length).fill(12),
    });

    expect(openReviewCommentSensitiveEnvelopeV1({
      structural: split.structural,
      envelope: encrypted,
      mode: 'e2ee',
    })).toEqual({
      status: 'locked',
      reason: 'encryption_material_unavailable',
      structural: split.structural,
      envelope: encrypted,
    });
    expect(openReviewCommentSensitiveEnvelopeV1({
      structural: split.structural,
      envelope: encrypted,
      mode: 'e2ee',
      material: OTHER_MATERIAL,
    })).toEqual({
      status: 'locked',
      reason: 'content_unreadable',
      structural: split.structural,
      envelope: encrypted,
    });
  });

  it('opens one stored projection or preserves a typed locked row without losing list position', () => {
    const split = splitReviewCommentV1(comment());
    const encrypted = sealReviewCommentSensitiveEnvelopeV1({
      structural: split.structural,
      sensitive: split.sensitive,
      mode: 'e2ee',
      material: MATERIAL,
      randomBytes: (length) => new Uint8Array(length).fill(15),
    });
    const stored = {
      v: 1 as const,
      structural: split.structural,
      sensitiveEnvelope: encrypted,
    };

    expect(openStoredReviewCommentV1({
      stored,
      mode: 'e2ee',
      material: MATERIAL,
    })).toEqual({ status: 'available', comment: comment() });
    expect(openStoredReviewCommentV1({
      stored,
      mode: 'e2ee',
    })).toEqual({
      status: 'locked',
      reason: 'encryption_material_unavailable',
      structural: split.structural,
      envelope: encrypted,
    });
  });

  it('rejects transplanting a comment payload under another structural identity', () => {
    const split = splitReviewCommentV1(comment());
    const encrypted = sealReviewCommentSensitiveEnvelopeV1({
      structural: split.structural,
      sensitive: split.sensitive,
      mode: 'e2ee',
      material: MATERIAL,
      randomBytes: (length) => new Uint8Array(length).fill(13),
    });
    const transplanted = {
      ...split.structural,
      id: 'comment-2',
      threadId: 'comment-2',
    };

    expect(openReviewCommentSensitiveEnvelopeV1({
      structural: transplanted,
      envelope: encrypted,
      mode: 'e2ee',
      material: MATERIAL,
    })).toEqual({
      status: 'locked',
      reason: 'content_binding_mismatch',
      structural: transplanted,
      envelope: encrypted,
    });
  });
});

describe('Review Comment event-sensitive binding', () => {
  it('builds the canonical one-roundtrip mutation envelope without server-generated facts', () => {
    const eventEnvelope = buildReviewCommentMutationEventEnvelopeV1({
      accountId: 'account-1',
      actor: { kind: 'user', userId: 'account-1' },
      actionId: 'reviews.comments.edit',
      input: {
        projectId: 'project-1',
        commentId: 'comment-1',
        expectedServerRevision: 4,
        expectedBodyVersion: 2,
        nextBody: 'updated body',
        clientMutationId: 'mutation-1',
        eventEnvelope: { t: 'plain', v: { stale: true } },
      },
      mode: 'plain',
    });

    expect(eventEnvelope).toEqual({
      t: 'plain',
      v: {
        v: 1,
        requestBinding: expect.objectContaining({
          accountId: 'account-1',
          projectId: 'project-1',
          actionId: 'reviews.comments.edit',
          eventKind: 'edited',
          actor: { kind: 'user', userId: 'account-1' },
          clientMutationId: 'mutation-1',
          target: { kind: 'comment', commentId: 'comment-1' },
          expectedCurrentness: {
            kind: 'edit',
            expectedServerRevision: 4,
            expectedBodyVersion: 2,
          },
        }),
        details: {
          projectId: 'project-1',
          commentId: 'comment-1',
          expectedServerRevision: 4,
          expectedBodyVersion: 2,
          nextBody: 'updated body',
          clientMutationId: 'mutation-1',
        },
      },
    });
    expect(JSON.stringify(eventEnvelope)).not.toContain('eventId');
    expect(JSON.stringify(eventEnvelope)).not.toContain('createdAt');
    expect(JSON.stringify(eventEnvelope)).not.toContain('bodyVersion":3');
  });

  it('binds ciphertext only to request-known facts and keeps server facts outside it', () => {
    const source = event();
    const requestBinding = buildReviewCommentEventRequestBindingV1({
      accountId: source.accountId,
      projectId: source.projectId,
      actor: source.actor,
      actionId: 'reviews.comments.transition',
      input: {
        commentId: source.commentId,
        projectId: source.projectId,
        toState: 'resolved',
        expectedState: 'open',
        expectedServerRevision: 1,
        clientMutationId: 'mutation-1',
      },
    });
    const sensitive = sealReviewCommentEventSensitiveEnvelopeV1({
      payload: { v: 1, requestBinding, details: source.event },
      mode: 'e2ee',
      material: MATERIAL,
      randomBytes: (length) => new Uint8Array(length).fill(14),
    });
    const bound = bindReviewCommentEventSensitiveEnvelopeV1({
      event: source,
      requestBinding,
      sensitive,
    });
    expect(classifyReviewCommentEventSensitiveMigrationLayoutV1(sensitive))
      .toBe('canonical_v1');
    expect(classifyReviewCommentEventSensitiveMigrationLayoutV1({
      t: 'encrypted',
      c: 'legacy-raw-ciphertext',
    })).toBe('legacy_split_v1');

    expect(openReviewCommentEventSensitiveEnvelopeV1({
      event: source,
      bound,
      mode: 'e2ee',
      material: MATERIAL,
    })).toEqual({ status: 'available', event: source });

    const serverRegenerated = event({
      eventId: 'event-2',
      createdAt: 30_000,
      serverRevision: 8,
    });
    const rebound = bindReviewCommentEventSensitiveEnvelopeV1({
      event: serverRegenerated,
      requestBinding,
      sensitive,
    });
    expect(openReviewCommentEventSensitiveEnvelopeV1({
      event: serverRegenerated,
      bound: rebound,
      mode: 'e2ee',
      material: MATERIAL,
    })).toEqual({ status: 'available', event: serverRegenerated });

    const transplanted = event({
      commentId: 'comment-2',
    });
    expect(openReviewCommentEventSensitiveEnvelopeV1({
      event: transplanted,
      bound,
      mode: 'e2ee',
      material: MATERIAL,
    })).toEqual({
      status: 'locked',
      reason: 'event_binding_mismatch',
      event: transplanted,
      bound,
    });
  });

  it('strictly bounds the authenticated Account-transition inventory', () => {
    const source = event();
    const requestBinding = buildReviewCommentEventRequestBindingV1({
      accountId: source.accountId,
      projectId: source.projectId,
      actor: source.actor,
      actionId: 'reviews.comments.transition',
      input: {
        commentId: source.commentId,
        projectId: source.projectId,
        toState: 'resolved',
        expectedState: 'open',
        expectedServerRevision: 1,
        clientMutationId: 'mutation-1',
      },
    });
    const split = splitReviewCommentV1(comment());
    const sensitive = sealReviewCommentEventSensitiveEnvelopeV1({
      payload: { v: 1, requestBinding, details: source.event },
      mode: 'plain',
    });
    const item = {
      structural: split.structural,
      sensitiveSource: {
        v: 1 as const,
        layout: 'canonical_v1' as const,
        envelope: sealReviewCommentSensitiveEnvelopeV1({
          structural: split.structural,
          sensitive: split.sensitive,
          mode: 'plain',
        }),
      },
      events: [{
        event: source,
        sensitiveEnvelope: bindReviewCommentEventSensitiveEnvelopeV1({
          event: source,
          requestBinding,
          sensitive,
        }),
        sourceLayout: 'canonical_v1' as const,
      }],
    };

    expect(ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema.parse({
      v: 1,
      items: [item],
    }).items).toHaveLength(1);
    expect(ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema.safeParse({
      v: 1,
      items: [{ ...item, extra: true }],
    }).success).toBe(false);
    expect(ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema.safeParse({
      v: 1,
      items: Array.from({ length: 201 }, () => item),
    }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  ReviewCommentActorRefV1Schema,
  ReviewCommentCreateRequestV1Schema,
  ReviewCommentEventV1Schema,
  ReviewCommentSnapshotV1Schema,
  ReviewCommentTransitionRequestV1Schema,
  ReviewCommentV1Schema,
} from './v1.js';

describe('ReviewCommentV1Schema', () => {
  it('accepts the broad durable comment shape with current state and append-only transitions', () => {
    const parsed = ReviewCommentV1Schema.parse({
      v: 1,
      id: 'comment-1',
      accountId: 'account-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      runId: 'run-1',
      engineId: 'review-coderabbit',
      findingId: 'finding-1',
      anchor: { kind: 'line', filePath: 'src/example.ts', line: 12, side: 'after' },
      snapshot: {
        kind: 'text',
        selectedLines: ['return value!.name;'],
        beforeContext: ['function read(value?: User) {'],
        afterContext: ['}'],
        selectedLinesHash: 'sha256:selected',
        contextWindowHash: 'sha256:context',
        capturedAt: 1710000000000,
        fileLength: 3,
        source: 'workingTree',
        isUncommitted: true,
        isUntracked: false,
        truncated: false,
        hasBidiControls: false,
        likelyMinified: false,
      },
      body: 'Null-check this before dereferencing.',
      bodyVersion: 1,
      edits: [],
      author: { kind: 'plugin', pluginId: 'review-coderabbit', engineRunId: 'run-1' },
      state: 'proposed',
      flags: { stale: true },
      dispositions: { 'user:user-1': 'working' },
      threadId: 'comment-1',
      evidence: [{ kind: 'reasoning', message: 'The value can be undefined.' }],
      transitions: [
        {
          transitionId: 'transition-1',
          toState: 'proposed',
          transitionedAt: 1710000000000,
          transitionedBy: { kind: 'plugin', pluginId: 'review-coderabbit', engineRunId: 'run-1' },
          evidence: [{ kind: 'reasoning', message: 'The value can be undefined.' }],
          clientMutationId: 'mutation-1',
          authorDeviceId: 'device-1',
          clientLamport: 1,
          serverRevision: 1,
        },
      ],
      fingerprint: {
        ruleId: 'null-check',
        fileSha: 'sha256:file',
        lineRange: { startLine: 12, endLine: 12 },
        normalizedMessageHash: 'sha256:message',
        engineId: 'review-coderabbit',
      },
      linkedRefs: [{ kind: 'executionRun', id: 'run-1' }],
      suggestedFix: { kind: 'replacement', replacementText: 'return value?.name ?? null;' },
      createdAt: 1710000000000,
      updatedAt: 1710000000001,
      serverRevision: 1,
      metadata: { severity: 'warning', taxonomyIds: ['correctness.nullability'], tags: ['typescript'] },
    });

    expect(parsed.id).toBe('comment-1');
    expect(parsed.threadId).toBe(parsed.id);
    expect(parsed.author.kind).toBe('plugin');
    expect(parsed.transitions).toHaveLength(1);
  });

  it('rejects legacy focused commentId/createdBy shape as the durable v1 row', () => {
    expect(() => ReviewCommentV1Schema.parse({
      commentId: 'comment-1',
      projectId: 'project-1',
      state: 'proposed',
      body: 'Legacy focused shape',
      anchor: { kind: 'file', filePath: 'src/example.ts' },
      snapshot: { kind: 'too_large', filePath: 'src/example.ts', sizeBytes: 10, capBytes: 5, capturedAt: 1 },
      createdBy: { kind: 'plugin', pluginId: 'review-coderabbit' },
      createdAt: 1,
      updatedAt: 1,
      serverRevision: 1,
    })).toThrow();
  });

  it('allows durable redacted rows to remove body text while authoring requests still require text', () => {
    const parsed = ReviewCommentV1Schema.parse({
      v: 1,
      id: 'comment-1',
      accountId: 'account-1',
      projectId: 'project-1',
      anchor: { kind: 'file', filePath: 'src/a.ts' },
      snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 10, capBytes: 1, capturedAt: 1 },
      body: '',
      bodyVersion: 1,
      edits: [],
      author: { kind: 'user', userId: 'user-1' },
      state: 'open',
      flags: { redacted: true },
      dispositions: {},
      threadId: 'comment-1',
      transitions: [
        {
          transitionId: 'transition-1',
          toState: 'open',
          transitionedAt: 1,
          transitionedBy: { kind: 'user', userId: 'user-1' },
        },
      ],
      createdAt: 1,
      updatedAt: 2,
      serverRevision: 2,
    });

    expect(parsed.body).toBe('');
    expect(() => ReviewCommentCreateRequestV1Schema.parse({
      projectId: 'project-1',
      anchor: { kind: 'file', filePath: 'src/a.ts' },
      snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 10, capBytes: 1, capturedAt: 1 },
      body: '',
      clientMutationId: 'mutation-1',
    })).toThrow();
  });

  it('parses a proposed plugin review comment with durable snapshot evidence', () => {
    const parsed = ReviewCommentV1Schema.parse({
      v: 1,
      id: 'comment-1',
      accountId: 'account-1',
      projectId: 'project-1',
      runId: 'run-1',
      engineId: 'review-coderabbit',
      state: 'proposed',
      body: 'Validate this null path before dereferencing it.',
      bodyVersion: 1,
      edits: [],
      anchor: {
        kind: 'range',
        filePath: 'src/example.ts',
        startLine: 12,
        endLine: 14,
        side: 'after',
      },
      snapshot: {
        kind: 'text',
        selectedLines: ['foo();'],
        beforeContext: ['if (value) {'],
        afterContext: ['}'],
        selectedLinesHash: 'sha256:line-hash',
        contextWindowHash: 'sha256:context-hash',
        capturedAt: 1710000000000,
        fileLength: 48,
        source: 'workingTree',
        isUncommitted: true,
        isUntracked: false,
        truncated: false,
        hasBidiControls: false,
        likelyMinified: false,
      },
      author: { kind: 'plugin', pluginId: 'review-coderabbit', engineRunId: 'run-1' },
      flags: {},
      dispositions: {},
      threadId: 'comment-1',
      transitions: [
        {
          transitionId: 'transition-1',
          toState: 'proposed',
          transitionedAt: 1710000000001,
          transitionedBy: { kind: 'plugin', pluginId: 'review-coderabbit', engineRunId: 'run-1' },
          evidence: [{ kind: 'reasoning', message: 'The path can be null.' }],
          clientMutationId: 'mutation-1',
          authorDeviceId: 'device-1',
          clientLamport: 2,
          serverRevision: 1,
        },
      ],
      createdAt: 1710000000001,
      updatedAt: 1710000000001,
      serverRevision: 1,
      evidence: [{ kind: 'reasoning', message: 'The path can be null.' }],
      fingerprint: {
        ruleId: 'null-check',
        fileSha: 'sha256:file',
        lineRange: { startLine: 12, endLine: 14 },
        normalizedMessageHash: 'sha256:message',
        engineId: 'review-coderabbit',
      },
    });

    expect(parsed.state).toBe('proposed');
    expect(parsed.anchor.kind).toBe('range');
    expect(parsed.author.kind).toBe('plugin');
  });

  it('rejects invalid anchors and accepts non-text snapshots without forcing line fields', () => {
    expect(() => ReviewCommentV1Schema.parse({
      v: 1,
      id: 'comment-1',
      accountId: 'account-1',
      projectId: 'project-1',
      runId: 'run-1',
      state: 'open',
      body: 'Invalid range',
      bodyVersion: 1,
      edits: [],
      anchor: { kind: 'range', filePath: 'src/example.ts', startLine: 15, endLine: 10 },
      snapshot: { kind: 'too_large', filePath: 'src/example.ts', sizeBytes: 9000, capBytes: 1000, capturedAt: 1 },
      author: { kind: 'user', userId: 'user-1' },
      flags: {},
      dispositions: {},
      threadId: 'comment-1',
      transitions: [
        {
          transitionId: 'transition-1',
          toState: 'open',
          transitionedAt: 1,
          transitionedBy: { kind: 'user', userId: 'user-1' },
          serverRevision: 1,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
      serverRevision: 1,
    })).toThrow();

    const snapshot = ReviewCommentSnapshotV1Schema.parse({
      kind: 'binary',
      sizeBytes: 100,
      sha256: 'abc',
      source: 'committed',
      capturedAt: 2,
    });
    expect(snapshot.kind).toBe('binary');
  });
});

describe('review comment mutation schemas', () => {
  it('defaults plugin-created comments to proposed unless direct write is explicit', () => {
    expect(ReviewCommentActorRefV1Schema.parse({ kind: 'plugin', pluginId: 'review-deepsec' }).kind)
      .toBe('plugin');

    const proposed = ReviewCommentCreateRequestV1Schema.parse({
      projectId: 'project-1',
      runId: 'run-2',
      body: 'Investigate this secret exposure.',
      anchor: { kind: 'file', filePath: 'src/config.ts' },
      snapshot: { kind: 'too_large', filePath: 'src/config.ts', sizeBytes: 5000000, capBytes: 1024, capturedAt: 1 },
      authorIntent: 'propose',
      clientMutationId: 'mutation-2',
      authorDeviceId: 'device-2',
      clientLamport: 3,
    });
    expect(proposed.authorIntent).toBe('propose');

    const direct = ReviewCommentCreateRequestV1Schema.parse({
      ...proposed,
      authorIntent: 'open',
    });
    expect(direct.authorIntent).toBe('open');
  });

  it('requires evidence for resolving comments and emits append-only event rows', () => {
    expect(() => ReviewCommentTransitionRequestV1Schema.parse({
      commentId: 'comment-1',
      toState: 'resolved',
      clientMutationId: 'mutation-3',
    })).toThrow();

    const transition = ReviewCommentTransitionRequestV1Schema.parse({
      commentId: 'comment-1',
      toState: 'resolved',
      evidence: [{ kind: 'test', testResultRef: 'test-run-1', status: 'passed' }],
      clientMutationId: 'mutation-3',
    });
    expect(transition.toState).toBe('resolved');

    const event = ReviewCommentEventV1Schema.parse({
      eventId: 'event-1',
      commentId: 'comment-1',
      accountId: 'account-1',
      projectId: 'project-1',
      eventKind: 'transitioned',
      actor: { kind: 'user', userId: 'user-1' },
      createdAt: 1710000000002,
      serverRevision: 2,
      event: { transition },
    });
    expect(event.eventKind).toBe('transitioned');
  });
});

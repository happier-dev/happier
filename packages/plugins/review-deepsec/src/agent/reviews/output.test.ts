import type {
  PluginReviewCommentsServiceV1,
  ReviewCommentSnapshotV1,
  ReviewCommentV1,
} from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { mapDeepSecReviewComments } from './comments.js';
import { normalizeDeepSecFindings } from './findings.js';
import { parseDeepSecCommentOutMarkdown } from './commentOut.js';

const snapshot: ReviewCommentSnapshotV1 = {
  kind: 'text',
  selectedLines: ['res.redirect(req.query.next)'],
  beforeContext: [],
  afterContext: [],
  selectedLinesHash: 'selected-hash',
  contextWindowHash: 'context-hash',
  capturedAt: 123,
  fileLength: 1,
  source: 'workingTree',
  isUncommitted: true,
  isUntracked: false,
  truncated: false,
  hasBidiControls: false,
  likelyMinified: false,
};

describe('DeepSec output mapping', () => {
  it('normalizes security findings into shared review finding envelopes', () => {
    const entries = parseDeepSecCommentOutMarkdown(`
### src/auth.ts:42

**Severity:** critical
**Rule:** CWE-601
**Category:** open_redirect

Validate redirect destinations before use.
`);

    expect(normalizeDeepSecFindings(entries)).toEqual([
      expect.objectContaining({
        id: 'deepsec-1',
        title: 'Validate redirect destinations before use.',
        severity: 'blocker',
        category: 'security',
        filePath: 'src/auth.ts',
        startLine: 42,
        endLine: 42,
        summary: 'Validate redirect destinations before use.',
        confidence: 0.9,
        ruleId: 'CWE-601',
        taxonomy: expect.objectContaining({
          family: 'cwe',
          id: 'CWE-601',
        }),
      }),
    ]);
  });

  it('normalizes secret findings with security taxonomy metadata', () => {
    const entries = parseDeepSecCommentOutMarkdown(`
### src/config.ts:3

**Severity:** high
**Category:** secrets

Remove the committed API token.
`);

    expect(normalizeDeepSecFindings(entries)).toEqual([
      expect.objectContaining({
        category: 'security',
        filePath: 'src/config.ts',
        severity: 'high',
        deepsecCategory: 'secrets',
        taxonomy: {
          family: 'secrets',
          id: 'secrets',
        },
      }),
    ]);
  });

  it('creates proposed comments through R.0 with fresh snapshots and low-confidence fallback tags', async () => {
    const entries = parseDeepSecCommentOutMarkdown(`
### src/auth.ts

**Severity:** high
**Rule:** CWE-601

Validate redirect destinations before use.
`);
    const createRequests: unknown[] = [];
    const resolveSnapshot = vi.fn(async () => snapshot);
    const localSnapshotPolicy = vi.fn(async () => {
      throw new Error('DeepSec must not run plugin-local snapshot capture policy');
    });
    const comments: Pick<PluginReviewCommentsServiceV1, 'create' | 'resolveSnapshot'> = {
      resolveSnapshot,
      async create(request) {
        createRequests.push(request);
        const now = 123;
        const comment: ReviewCommentV1 = {
          v: 1,
          id: 'comment-1',
          accountId: 'account-1',
          projectId: request.projectId,
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          runId: request.runId,
          engineId: request.engineId,
          findingId: request.findingId,
          state: 'proposed',
          body: request.body,
          bodyVersion: 1,
          anchor: request.anchor,
          snapshot: request.snapshot,
          author: { kind: 'plugin', pluginId: 'review-deepsec', engineRunId: request.runId },
          flags: {},
          dispositions: {},
          threadId: 'comment-1',
          evidence: request.evidence,
          transitions: [],
          fingerprint: request.fingerprint,
          createdAt: now,
          updatedAt: now,
          serverRevision: 1,
          edits: [],
          metadata: request.metadata,
        };
        return { comment };
      },
    };

    const params = {
      projectId: 'project-1',
      runId: 'run-1',
      entries,
      comments,
      snapshotForEntry: localSnapshotPolicy,
    };
    const created = await mapDeepSecReviewComments(params);

    expect(created).toHaveLength(1);
    expect(resolveSnapshot).toHaveBeenCalledWith({
      projectId: 'project-1',
      runId: 'run-1',
      engineId: 'deepsec',
      anchor: { kind: 'file', filePath: 'src/auth.ts' },
    });
    expect(localSnapshotPolicy).not.toHaveBeenCalled();
    expect(createRequests[0]).toMatchObject({
      projectId: 'project-1',
      runId: 'run-1',
      engineId: 'deepsec',
      body: 'Validate redirect destinations before use.',
      anchor: { kind: 'file', filePath: 'src/auth.ts' },
      snapshot,
      authorIntent: 'propose',
      metadata: {
        severity: 'error',
        taxonomyIds: ['CWE-601'],
        tags: ['deepsec.low_confidence_anchor'],
      },
    });
  });

  it('preserves range anchors in proposed comment fingerprints', async () => {
    const entries = parseDeepSecCommentOutMarkdown(`
### src/auth.ts:42-45

Validate the full redirect block.
`);
    const requests: unknown[] = [];
    const comments: Pick<PluginReviewCommentsServiceV1, 'create' | 'resolveSnapshot'> = {
      resolveSnapshot: vi.fn(async () => snapshot),
      async create(request) {
        requests.push(request);
        const now = 123;
        const comment: ReviewCommentV1 = {
          v: 1,
          id: 'comment-range',
          accountId: 'account-1',
          projectId: request.projectId,
          runId: request.runId,
          engineId: request.engineId,
          state: 'proposed',
          body: request.body,
          bodyVersion: 1,
          anchor: request.anchor,
          snapshot: request.snapshot,
          author: { kind: 'plugin', pluginId: 'review-deepsec', engineRunId: request.runId },
          flags: {},
          dispositions: {},
          threadId: 'comment-range',
          evidence: request.evidence,
          transitions: [],
          fingerprint: request.fingerprint,
          createdAt: now,
          updatedAt: now,
          serverRevision: 1,
          edits: [],
          metadata: request.metadata,
        };
        return { comment };
      },
    };

    await mapDeepSecReviewComments({
      projectId: 'project-1',
      runId: 'run-1',
      entries,
      comments,
    });

    expect(requests[0]).toMatchObject({
      anchor: { kind: 'range', filePath: 'src/auth.ts', startLine: 42, endLine: 45 },
      fingerprint: {
        lineRange: { startLine: 42, endLine: 45 },
        engineId: 'deepsec',
      },
    });
  });

  it('uses the canonical review fingerprint without embedding the raw comment body', async () => {
    const entries = parseDeepSecCommentOutMarkdown(`
### src/auth.ts:42

**Rule:** security

Validate redirect destinations before use.
`);
    const requests: unknown[] = [];
    const comments: Pick<PluginReviewCommentsServiceV1, 'create' | 'resolveSnapshot'> = {
      resolveSnapshot: vi.fn(async () => snapshot),
      async create(request) {
        requests.push(request);
        const now = 123;
        const comment: ReviewCommentV1 = {
          v: 1,
          id: 'comment-fingerprint',
          accountId: 'account-1',
          projectId: request.projectId,
          runId: request.runId,
          engineId: request.engineId,
          state: 'proposed',
          body: request.body,
          bodyVersion: 1,
          anchor: request.anchor,
          snapshot: request.snapshot,
          author: { kind: 'plugin', pluginId: 'review-deepsec', engineRunId: request.runId },
          flags: {},
          dispositions: {},
          threadId: 'comment-fingerprint',
          evidence: request.evidence,
          transitions: [],
          fingerprint: request.fingerprint,
          createdAt: now,
          updatedAt: now,
          serverRevision: 1,
          edits: [],
          metadata: request.metadata,
        };
        return { comment };
      },
    };

    await mapDeepSecReviewComments({
      projectId: 'project-1',
      runId: 'run-1',
      entries,
      comments,
    });

    const fingerprint = (requests[0] as {
      fingerprint?: { normalizedMessageHash?: string };
    }).fingerprint;

    expect(requests[0]).toMatchObject({
      fingerprint: {
        ruleId: 'security',
        lineRange: { startLine: 42, endLine: 42 },
        engineId: 'deepsec',
      },
    });
    expect(fingerprint?.normalizedMessageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(fingerprint)).not.toContain('Validate redirect destinations before use.');
  });

  it('skips proposed comments when the host R.0 snapshot resolver cannot capture the anchor', async () => {
    const entries = parseDeepSecCommentOutMarkdown(`
### src/missing.ts:7

Validate missing file references.
`);
    const create = vi.fn<PluginReviewCommentsServiceV1['create']>();
    const comments: Pick<PluginReviewCommentsServiceV1, 'create' | 'resolveSnapshot'> = {
      create,
      resolveSnapshot: vi.fn(async () => null),
    };

    const created = await mapDeepSecReviewComments({
      projectId: 'project-1',
      runId: 'run-1',
      entries,
      comments,
    });

    expect(created).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect(comments.resolveSnapshot).toHaveBeenCalledWith({
      projectId: 'project-1',
      runId: 'run-1',
      engineId: 'deepsec',
      anchor: { kind: 'line', filePath: 'src/missing.ts', line: 7 },
    });
  });
});

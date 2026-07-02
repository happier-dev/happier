import type { ReviewCommentSnapshotV1 } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { mapCodeRabbitReviewComments } from './comments.js';

function textSnapshot(filePath: string): ReviewCommentSnapshotV1 {
  return {
    kind: 'text',
    selectedLines: ['if (allowed) return target;'],
    beforeContext: [],
    afterContext: [],
    selectedLinesHash: `selected:${filePath}`,
    contextWindowHash: `context:${filePath}`,
    capturedAt: 1,
    fileLength: 1,
    source: 'workingTree',
    isUncommitted: true,
    isUntracked: false,
    truncated: false,
    hasBidiControls: false,
    likelyMinified: false,
  };
}

describe('mapCodeRabbitReviewComments', () => {
  it('creates proposed comments with real caller-resolved snapshots', async () => {
    const created: unknown[] = [];
    const comments = await mapCodeRabbitReviewComments({
      projectId: 'project-1',
      runId: 'run-1',
      findings: [{
        id: 'finding-1',
        title: 'Title',
        severity: 'high',
        category: 'correctness',
        filePath: 'src/index.ts',
        startLine: 4,
        endLine: 4,
        summary: 'Check this condition.',
      }],
      comments: {
        resolveSnapshot: async ({ finding }) => textSnapshot(finding.filePath ?? 'src/index.ts'),
        create: async (request) => {
          created.push(request);
          return {
            comment: {
              commentId: 'comment-1',
              runId: 'run-1',
              state: 'proposed',
              body: request.body,
              anchor: request.anchor,
              snapshot: request.snapshot,
              evidence: [],
              createdBy: { kind: 'plugin', pluginId: 'review-coderabbit' },
              createdAt: 1,
              updatedAt: 1,
              serverRevision: 1,
              metadata: {},
              edits: [],
            },
          };
        },
      },
    });

    expect(comments).toHaveLength(1);
    expect(created[0]).toMatchObject({
      projectId: 'project-1',
      runId: 'run-1',
      engineId: 'coderabbit',
      findingId: 'finding-1',
      body: 'Check this condition.',
      authorIntent: 'propose',
      anchor: { kind: 'line', filePath: 'src/index.ts', line: 4 },
      snapshot: {
        kind: 'text',
        selectedLinesHash: 'selected:src/index.ts',
      },
    });
  });

  it('does not synthesize placeholder snapshots when no snapshot can be resolved', async () => {
    const created: unknown[] = [];
    const comments = await mapCodeRabbitReviewComments({
      projectId: 'project-1',
      runId: 'run-1',
      findings: [{
        id: 'finding-1',
        title: 'Title',
        severity: 'high',
        category: 'correctness',
        filePath: 'src/index.ts',
        startLine: 4,
        summary: 'Check this condition.',
      }],
      comments: {
        resolveSnapshot: async () => null,
        create: async (request) => {
          created.push(request);
          return {
            comment: {
              commentId: 'comment-1',
              runId: 'run-1',
              state: 'proposed',
              body: request.body,
              anchor: request.anchor,
              snapshot: request.snapshot,
              evidence: [],
              createdBy: { kind: 'plugin', pluginId: 'review-coderabbit' },
              createdAt: 1,
              updatedAt: 1,
              serverRevision: 1,
              metadata: {},
              edits: [],
            },
          };
        },
      },
    });

    expect(comments).toEqual([]);
    expect(created).toEqual([]);
  });
});

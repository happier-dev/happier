import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '../../rpc.js';

import {
  WorkspaceAnchorV1Schema,
  WorkspaceAnchorsResolveRequestV1Schema,
  WorkspaceAnchorsResolveResponseV1Schema,
  computeLineContentHashV1,
} from './v1.js';

describe('workspace anchor protocol v1', () => {
  it('defines a non-durable machine RPC method for workspace anchor resolution', () => {
    expect(RPC_METHODS.WORKSPACE_ANCHORS_RESOLVE).toBe('workspace.anchors.resolve');
  });

  it('parses line and range anchors without requiring durable review-comment storage fields', () => {
    expect(WorkspaceAnchorV1Schema.parse({
      kind: 'line',
      filePath: 'src/index.ts',
      line: 12,
      lineHash: 'lh1:1234567890abcdef',
    })).toMatchObject({ kind: 'line', line: 12 });

    expect(WorkspaceAnchorV1Schema.parse({
      kind: 'range',
      filePath: 'src/index.ts',
      startLine: 12,
      endLine: 14,
      side: 'after',
      startLineHash: 'lh1:1234567890abcdef',
      endLineHash: 'lh1:fedcba0987654321',
    })).toMatchObject({ kind: 'range', startLine: 12, endLine: 14 });
  });

  it('rejects invalid ranges at the protocol boundary', () => {
    expect(() => WorkspaceAnchorV1Schema.parse({
      kind: 'range',
      filePath: 'src/index.ts',
      startLine: 14,
      endLine: 12,
    })).toThrow(/endLine/);
  });

  it('parses batched resolve requests and partial-success responses', () => {
    const request = WorkspaceAnchorsResolveRequestV1Schema.parse({
      workspacePath: '/repo',
      comments: [{
        id: 'c1',
        filePath: 'src/index.ts',
        source: 'file',
        anchor: { kind: 'line', filePath: 'src/index.ts', line: 2 },
        snapshot: {
          selectedLines: ['const value = 1;'],
          beforeContext: [],
          afterContext: [],
        },
      }],
    });

    expect(request.comments).toHaveLength(1);

    expect(WorkspaceAnchorsResolveResponseV1Schema.parse({
      success: true,
      resolutions: [{
        id: 'c1',
        filePath: 'src/index.ts',
        originalAnchor: { kind: 'line', filePath: 'src/index.ts', line: 2 },
        resolvedAnchor: { kind: 'line', filePath: 'src/index.ts', line: 2 },
        status: 'exact',
        confidence: 1,
      }],
    })).toMatchObject({ success: true });
  });

  it('uses the same deterministic line hash algorithm as review-comment drafts', () => {
    expect(computeLineContentHashV1('const value = 1;')).toMatch(/^lh1:[0-9a-f]{16}$/);
    expect(computeLineContentHashV1('const value = 1;')).toBe(computeLineContentHashV1('const value = 1;'));
    expect(computeLineContentHashV1('const value = 1;')).not.toBe(computeLineContentHashV1('const value = 2;'));
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { zodSchemaToJsonSchemaObject } from '../../../actions/actionInputJsonSchema.js';

import {
  areWorkspaceSyncRelationshipDefinitionsEqual,
  computeWorkspaceSyncPolicyDigest,
  deriveWorkspaceSyncConflictAsidePaths,
  deriveWorkspaceSyncConflictOperationId,
  HandoffTargetReplacementPreflightV1Schema,
  HandoffWorkspaceActionV1Schema,
  HandoffWorkspaceOutcomeV1Schema,
  ReadWorkspaceSyncFileV1Schema,
  ReadWorkspaceSyncFileResultV1Schema,
  WorkspaceContentPolicyV1Schema,
  WorkspaceSyncConflictListV1Schema,
  WorkspaceSyncConflictPageRequestV1Schema,
  WorkspaceSyncConflictPageV1Schema,
  WorkspaceSyncConflictResolutionV1Schema,
  WorkspaceSyncConflictResolveRpcInputV1Schema,
  WORKSPACE_SYNC_CONFLICT_PAGE_MAX_ITEMS,
  WorkspaceSyncEntryExpectationV1Schema,
  WorkspaceSyncLegacyStateInspectionV1Schema,
  WorkspaceSyncRelationshipV1Schema,
  WorkspaceSyncTargetBootstrapPrepareResultV1Schema,
  WorkspaceSyncTargetBootstrapPrepareV1Schema,
  WorkspaceSyncTargetBootstrapReleaseResultV1Schema,
  WorkspaceSyncTargetBootstrapReleaseV1Schema,
  WorkspaceSyncTargetFileReadV1Schema,
  WorkspaceSyncStatusV1Schema,
  WorkspaceSyncRuntimeEventV1Schema,
} from './workspaceSyncSchemas.js';
import {
  SessionHandoffPrepareTargetResultGetResponseSchema,
  SessionHandoffStartRequestSchema,
} from './handoffSchemas.js';
import {
  HandoffTargetReplacementApprovalV1Schema,
  sameHandoffTargetReplacementApproval,
} from './handoffTargetReplacementApprovalV1.js';

const contentPolicyInput = {
  v: 1 as const,
  selection: 'git_worktree' as const,
  extraIgnorePatterns: [],
  extraIncludePatterns: [],
};
const contentPolicy = { ...contentPolicyInput, policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicyInput) };

describe('workspace sync protocol schemas', () => {
  it('preserves classic JSON Schema projection and fluent request composition', () => {
    const request = z.object({
      relationshipId: z.string().trim().min(1).max(256),
      cursor: z.string().trim().min(1).max(256).optional(),
      limit: z.number().int().positive().max(WORKSPACE_SYNC_CONFLICT_PAGE_MAX_ITEMS),
    }).strict();
    const fileResult = z.discriminatedUnion('status', [
      z.object({
        status: z.literal('text'),
        text: z.string().max(1024 * 1024),
        digest: z.string().regex(/^[a-f0-9]{40}$/u),
        size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }).strict(),
      z.object({
        status: z.literal('binary'),
        digest: z.string().regex(/^[a-f0-9]{40}$/u),
        size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }).strict(),
      z.object({
        status: z.literal('too_large'),
        digest: z.string().regex(/^[a-f0-9]{40}$/u).optional(),
        size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }).strict(),
      z.object({ status: z.literal('missing') }).strict(),
      z.object({
        status: z.literal('changed'),
        actualDigest: z.string().regex(/^[a-f0-9]{40}$/u).optional(),
      }).strict(),
    ]);
    for (const target of ['draft-2020-12', 'draft-7'] as const) {
      expect(zodSchemaToJsonSchemaObject(WorkspaceSyncConflictPageRequestV1Schema, { target }))
        .toEqual(zodSchemaToJsonSchemaObject(request, { target }));
      expect(zodSchemaToJsonSchemaObject(z.object({
        request: WorkspaceSyncConflictPageRequestV1Schema.optional(),
        results: z.array(ReadWorkspaceSyncFileResultV1Schema),
      }).strict(), { target })).toEqual(zodSchemaToJsonSchemaObject(z.object({
        request: request.optional(), results: z.array(fileResult),
      }).strict(), { target }));
    }
    expect(WorkspaceSyncConflictPageRequestV1Schema.extend({ enabled: z.boolean().default(true) })
      .parse({ relationshipId: ' rel-1 ', limit: 10 }))
      .toEqual({ relationshipId: 'rel-1', limit: 10, enabled: true });
    expect(WorkspaceSyncConflictPageRequestV1Schema.shape.cursor.parse(undefined)).toBeUndefined();
    expect(ReadWorkspaceSyncFileResultV1Schema.options[3].nullable().parse(null)).toBeNull();
  });

  it('preserves classic errors for structural and content-policy refinement failures', () => {
    const structural = WorkspaceSyncConflictPageRequestV1Schema.safeParse({
      relationshipId: 'rel-1', limit: 0, extra: true,
    });
    expect(structural.success).toBe(false);
    if (!structural.success) {
      expect(structural.error).toBeInstanceOf(z.ZodError);
      expect(structural.error.issues).toMatchObject([
        { code: 'too_small', path: ['limit'] },
        { code: 'unrecognized_keys', path: [], keys: ['extra'] },
      ]);
    }
    expect(() => WorkspaceSyncConflictPageRequestV1Schema.parse({ relationshipId: 'rel-1', limit: 0 }))
      .toThrow(z.ZodError);
    const refined = WorkspaceContentPolicyV1Schema.safeParse({
      ...contentPolicy, policyDigest: '0'.repeat(64),
    });
    expect(refined.success).toBe(false);
    if (!refined.success) {
      expect(refined.error).toBeInstanceOf(z.ZodError);
      expect(refined.error.issues).toMatchObject([{ code: 'custom', path: ['policyDigest'] }]);
    }
  });

  it('binds complete entry expectations and explicit resolution endpoints', () => {
    const missing = { kind: 'missing' as const };
    const file = { kind: 'file' as const, digest: 'a'.repeat(40), executable: true, size: 7 };
    const symlink = { kind: 'symlink' as const, target: '../actual' };
    const directory = { kind: 'directory' as const, fingerprint: 'b'.repeat(64) };

    for (const expectation of [missing, file, symlink, directory]) {
      expect(WorkspaceSyncEntryExpectationV1Schema.parse(expectation)).toEqual(expectation);
    }
    expect(WorkspaceSyncEntryExpectationV1Schema.safeParse({ kind: 'file', digest: 'a'.repeat(40), size: 7 }).success).toBe(false);
    expect(WorkspaceSyncEntryExpectationV1Schema.safeParse({ kind: 'directory' }).success).toBe(false);
    expect(WorkspaceSyncEntryExpectationV1Schema.safeParse({ kind: 'unsupported' }).success).toBe(false);

    const resolution = {
      controllerMachineId: 'machine-controller',
      hubWorkspaceRefId: 'workspace-alpha',
      path: 'src/index.ts',
      source: { workspaceRefId: 'workspace-alpha', expected: file },
      targets: [{ workspaceRefId: 'workspace-beta', expected: missing }],
      relationshipIds: ['rel-1'],
      strategy: 'use_source' as const,
    };
    expect(WorkspaceSyncConflictResolutionV1Schema.parse(resolution)).toEqual(resolution);
    expect(WorkspaceSyncConflictResolutionV1Schema.safeParse({ ...resolution, targets: [] }).success).toBe(false);
    expect(WorkspaceSyncConflictResolutionV1Schema.safeParse({ ...resolution, relationshipIds: [] }).success).toBe(false);
    expect(WorkspaceSyncConflictResolutionV1Schema.safeParse({ ...resolution, strategy: 'keep_both' }).success).toBe(false);
    const asidePath = deriveWorkspaceSyncConflictAsidePaths(resolution.path, file)[0];
    const keepBoth = {
      ...resolution, strategy: 'keep_both' as const,
      alternatives: [{
        source: { workspaceRefId: 'workspace-beta', expected: file },
        destination: { workspaceRefId: 'workspace-alpha', path: asidePath, expected: missing },
        consequence: { propagatingToWorkspaceRefIds: ['workspace-beta'] },
      }],
    };
    expect(WorkspaceSyncConflictResolutionV1Schema.safeParse(keepBoth).success).toBe(true);
    expect(WorkspaceSyncConflictResolutionV1Schema.safeParse({
      ...keepBoth, alternatives: [{ ...keepBoth.alternatives[0], consequence: undefined }],
    }).success).toBe(false);
  });
  it('derives native-safe effect identities and bounded, discoverable aside names', () => {
    const file = { kind: 'file' as const, digest: 'a'.repeat(40), executable: false, size: 1 };
    const [ordinary, alternate] = deriveWorkspaceSyncConflictAsidePaths('src/file.ts', file);
    expect(ordinary).toBe(`src/file.ts.happier-conflict.${file.digest}`);
    expect(alternate).not.toBe(ordinary);
    const [compact] = deriveWorkspaceSyncConflictAsidePaths(`src/${'x'.repeat(240)}.ts`, file);
    expect(Buffer.byteLength(compact.split('/').at(-1)!, 'utf8')).toBeLessThanOrEqual(255);
    expect(compact.startsWith('src/')).toBe(true);
    const base = { actionReceiptId: 'receipt:with:unsafe:characters', kind: 'selected' as const, path: 'src/file.ts' };
    const first = deriveWorkspaceSyncConflictOperationId({ ...base, workspaceRefId: 'workspace-b' });
    const second = deriveWorkspaceSyncConflictOperationId({ ...base, workspaceRefId: 'workspace-c' });
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).not.toBe(first);
  });
  it('bounds content policy patterns by UTF-8 bytes as well as count', () => {
    const accepted = { ...contentPolicyInput, extraIgnorePatterns: ['x'.repeat(1024)] };
    expect(WorkspaceContentPolicyV1Schema.safeParse({
      ...accepted, policyDigest: computeWorkspaceSyncPolicyDigest(accepted),
    }).success).toBe(true);
    const oversized = { ...contentPolicyInput, extraIgnorePatterns: ['😀'.repeat(1024)] };
    expect(WorkspaceContentPolicyV1Schema.safeParse({
      ...oversized, policyDigest: computeWorkspaceSyncPolicyDigest(oversized),
    }).success).toBe(false);
  });

  it('rejects negated extra include patterns because includes are positive paths', () => {
    const negatedInclude = { ...contentPolicyInput, extraIncludePatterns: ['!src/generated.ts'] };
    expect(WorkspaceContentPolicyV1Schema.safeParse({
      ...negatedInclude, policyDigest: computeWorkspaceSyncPolicyDigest(negatedInclude),
    }).success).toBe(false);
  });

  it('publishes only strict read-only legacy-state inspection results', () => {
    expect(WorkspaceSyncLegacyStateInspectionV1Schema.parse({ status: 'absent' })).toEqual({ status: 'absent' });
    expect(WorkspaceSyncLegacyStateInspectionV1Schema.parse({
      status: 'legacy_workspace_sync_state_unsupported',
      classification: 'retired_v1',
      quarantinePath: '/private/state/workspace-replication.retired-123',
      schemaVersion: 1,
    })).toMatchObject({ classification: 'retired_v1', schemaVersion: 1 });
    expect(WorkspaceSyncLegacyStateInspectionV1Schema.parse({
      status: 'legacy_workspace_sync_state_unknown',
      path: '/private/state/workspace-replication',
      reason: 'unrecognized_entries',
    })).toMatchObject({ status: 'legacy_workspace_sync_state_unknown' });
    expect(WorkspaceSyncLegacyStateInspectionV1Schema.safeParse({ status: 'absent', cleanup: true }).success).toBe(false);
  });

  it('defines relationship runtime identity without mutable settings metadata', () => {
    const relationship = {
      v: 1 as const,
      relationshipId: 'rel-1',
      controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'workspace-a',
      betaWorkspaceRefId: 'workspace-b',
      mode: 'keep_synced' as const,
      contentPolicy,
      enabled: true,
      createdAtMs: 10,
      updatedAtMs: 11,
    };

    expect(areWorkspaceSyncRelationshipDefinitionsEqual(relationship, {
      ...relationship,
      relationshipId: 'another-settings-record',
      enabled: false,
      createdAtMs: 20,
      updatedAtMs: 21,
    })).toBe(true);

    for (const changed of [
      { ...relationship, controllerMachineId: 'machine-b' },
      { ...relationship, alphaWorkspaceRefId: 'workspace-c' },
      { ...relationship, betaWorkspaceRefId: 'workspace-c' },
      { ...relationship, mode: 'mirror_exactly' as const },
      { ...relationship, contentPolicy: { ...relationship.contentPolicy, policyDigest: 'b'.repeat(64) } },
    ]) {
      expect(areWorkspaceSyncRelationshipDefinitionsEqual(relationship, changed)).toBe(false);
    }
  });

  it('preserves ordered Git policy semantics in the canonical digest', () => {
    const shared = {
      v: 1 as const,
      selection: 'git_worktree' as const,
      extraIncludePatterns: [],
    };
    const includeAfterIgnore = computeWorkspaceSyncPolicyDigest({
      ...shared,
      extraIgnorePatterns: ['dist/**', '!dist/keep.txt'],
    });
    const ignoreAfterInclude = computeWorkspaceSyncPolicyDigest({
      ...shared,
      extraIgnorePatterns: ['!dist/keep.txt', 'dist/**'],
    });

    expect(includeAfterIgnore).not.toBe(ignoreAfterInclude);
  });

  it('always excludes the Git directory and cannot represent includeGitDirectory', () => {
    const base = {
      v: 1 as const,
      selection: 'git_worktree' as const,
      extraIgnorePatterns: [],
      extraIncludePatterns: [],
    };
    const policy = { ...base, policyDigest: computeWorkspaceSyncPolicyDigest(base) };

    expect(WorkspaceContentPolicyV1Schema.parse(policy)).toEqual(policy);
    expect(WorkspaceContentPolicyV1Schema.safeParse({ ...policy, includeGitDirectory: false }).success).toBe(false);
    expect(WorkspaceContentPolicyV1Schema.safeParse({ ...policy, includeGitDirectory: true }).success).toBe(false);
    expect(HandoffWorkspaceActionV1Schema.safeParse({
      kind: 'copy_once' as const,
      contentPolicy: { ...policy, includeGitDirectory: false },
    }).success).toBe(false);
  });

  it('accepts the four product modes and rejects copy_once relationships', () => {
    expect(HandoffWorkspaceActionV1Schema.parse({ kind: 'none' })).toEqual({ kind: 'none' });
    expect(HandoffWorkspaceActionV1Schema.parse({
      kind: 'copy_once',
      contentPolicy,
    })).toMatchObject({ kind: 'copy_once' });
    expect(HandoffWorkspaceActionV1Schema.parse({
      kind: 'create_relationship',
      mode: 'keep_synced',
      contentPolicy,
      flushBeforeCommit: true,
    })).toMatchObject({ kind: 'create_relationship', mode: 'keep_synced' });
    expect(HandoffWorkspaceActionV1Schema.safeParse({
      kind: 'create_relationship',
      mode: 'copy_once',
      contentPolicy,
      flushBeforeCommit: true,
    }).success).toBe(false);
    expect(HandoffWorkspaceActionV1Schema.safeParse({
      kind: 'create_relationship',
      mode: 'keep_synced',
      contentPolicy,
      targetBootstrap: 'use_existing',
      flushBeforeCommit: false,
    }).success).toBe(false);
    expect(HandoffWorkspaceActionV1Schema.parse({ kind: 'relationship', relationshipId: 'rel-1', flushBeforeCommit: true })).toMatchObject({ kind: 'relationship' });
    expect(HandoffWorkspaceActionV1Schema.parse({ kind: 'linked_workspace' })).toEqual({ kind: 'linked_workspace' });
    expect(HandoffWorkspaceActionV1Schema.safeParse({ kind: 'linked_workspace', sourceWorkspaceRefId: 'source' }).success).toBe(false);
    expect(HandoffWorkspaceActionV1Schema.safeParse({ kind: 'copy_once', contentPolicy }).success).toBe(true);
    expect(HandoffWorkspaceActionV1Schema.safeParse({
      kind: 'copy_once', contentPolicy, targetBootstrap: 'materialize_from_source_workspace',
    }).success).toBe(false);
    expect(HandoffWorkspaceActionV1Schema.safeParse({
      kind: 'copy_once', contentPolicy, destructiveTargetReuseApproved: true,
    }).success).toBe(false);
    expect(HandoffWorkspaceActionV1Schema.safeParse({
      kind: 'copy_once',
      contentPolicy,
      targetReplacementApproval: {
        v: 1,
        consequences: ['replace_nonempty_workspace_target'],
        serverId: 'server-1',
        machineId: 'machine-beta',
        canonicalRoot: '/workspace/beta',
        rootFingerprint: 'a'.repeat(64),
        operationId: 'handoff-action-1',
      },
    }).success).toBe(false);
    expect(HandoffWorkspaceActionV1Schema.safeParse({
      kind: 'relationship',
      relationshipId: 'rel-1',
      flushBeforeCommit: true,
      targetBootstrap: 'use_existing',
    }).success).toBe(false);

    expect(WorkspaceSyncRelationshipV1Schema.safeParse({
      v: 1,
      relationshipId: 'rel-1',
      controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'workspace-a',
      betaWorkspaceRefId: 'workspace-b',
      mode: 'keep_synced',
      contentPolicy,
      enabled: true,
      createdAtMs: 10,
      updatedAtMs: 11,
    }).success).toBe(true);
    expect(WorkspaceSyncRelationshipV1Schema.safeParse({
      v: 1,
      relationshipId: 'rel-1',
      controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'workspace-a',
      betaWorkspaceRefId: 'workspace-a',
      mode: 'copy_once',
      contentPolicy,
      enabled: true,
      createdAtMs: 10,
      updatedAtMs: 11,
    }).success).toBe(false);
  });

  it('keeps status and conflict projections strict and internally bounded', () => {
    expect(WorkspaceSyncStatusV1Schema.parse({
      relationshipId: 'rel-1',
      controllerMachineId: 'machine-a',
      state: 'watching',
      alphaPath: '/repo/a',
      betaPath: '/repo/b',
      mode: 'keep_both_in_sync',
      endpointStates: {
        alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        beta: null,
      },
      conflictCount: 1,
      lastCycleObservedAtMs: null,
    })).toMatchObject({ state: 'watching' });

    expect(WorkspaceSyncStatusV1Schema.safeParse({
      relationshipId: 'rel-1',
      controllerMachineId: 'machine-a',
      state: 'watching',
      alphaPath: '/repo/a',
      betaPath: '/repo/b',
      mode: 'keep_synced',
      endpointStates: {
        alpha: { connected: true, scanned: true, scanProblemCount: Number.MAX_SAFE_INTEGER + 1, transitionProblemCount: 0 },
        beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      },
      conflictCount: 0,
      lastCycleObservedAtMs: null,
    }).success).toBe(false);

    expect(WorkspaceSyncStatusV1Schema.safeParse({
      relationshipId: 'rel-1',
      controllerMachineId: 'machine-a',
      state: 'watching',
      alphaPath: '/repo/a',
      betaPath: '/repo/b',
      mode: 'keep_synced',
      endpointStates: {
        alpha: { connected: true, scanned: true, scanProblemCount: 0 },
        beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      },
      conflictCount: 0,
      lastCycleObservedAtMs: null,
    }).success).toBe(false);

    expect(WorkspaceSyncConflictListV1Schema.safeParse({
      relationshipId: 'rel-1',
      totalCount: 1,
      shownCount: 1,
      truncatedCount: 0,
      conflicts: [{
        relationshipId: 'rel-1',
        path: 'src/index.ts',
        alpha: { kind: 'file', digest: 'a'.repeat(40), size: 10 },
        beta: { kind: 'file', digest: 'b'.repeat(40), size: 12 },
      }],
    }).success).toBe(true);
    expect(WorkspaceSyncConflictPageRequestV1Schema.parse({
      relationshipId: 'rel-1',
      cursor: 'opaque-page-2',
      limit: 50,
    })).toEqual({ relationshipId: 'rel-1', cursor: 'opaque-page-2', limit: 50 });
    expect(WorkspaceSyncConflictPageRequestV1Schema.safeParse({
      relationshipId: 'rel-1',
      limit: 101,
    }).success).toBe(false);
    expect(WorkspaceSyncConflictPageV1Schema.parse({
      status: 'page',
      relationshipId: 'rel-1',
      totalCount: 2,
      nextCursor: 'opaque-page-2',
      conflicts: [{
        relationshipId: 'rel-1',
        path: 'src/index.ts',
        alpha: { kind: 'file', digest: 'a'.repeat(40), size: 10 },
        beta: { kind: 'file', digest: 'b'.repeat(40), size: 12 },
      }],
    })).toMatchObject({ status: 'page', totalCount: 2, nextCursor: 'opaque-page-2' });
    expect(WorkspaceSyncConflictPageV1Schema.parse({
      status: 'page',
      relationshipId: 'rel-1',
      totalCount: 1,
      nextCursor: null,
      conflicts: [{
        relationshipId: 'rel-1',
        path: 'ignored.sock',
        alpha: { kind: 'unsupported', sourceKind: 'untracked' },
        beta: { kind: 'file', digest: 'b'.repeat(40) },
      }],
    })).toMatchObject({
      conflicts: [{ alpha: { kind: 'unsupported', sourceKind: 'untracked' } }],
    });
    expect(WorkspaceSyncConflictPageV1Schema.safeParse({
      status: 'page',
      relationshipId: 'rel-1',
      totalCount: 1,
      nextCursor: null,
      conflicts: [{
        relationshipId: 'rel-1',
        path: 'ignored.sock',
        alpha: { kind: 'unsupported' },
        beta: { kind: 'missing' },
      }],
    }).success).toBe(false);
    expect(WorkspaceSyncConflictPageV1Schema.parse({
      status: 'cursor_invalidated',
      relationshipId: 'rel-1',
    })).toEqual({ status: 'cursor_invalidated', relationshipId: 'rel-1' });
    expect(WorkspaceSyncStatusV1Schema.safeParse({
      relationshipId: 'rel-1',
      controllerMachineId: 'machine-a',
      state: 'watching',
      alphaPath: '/repo/a',
      betaPath: '/repo/b',
      mode: 'keep_synced',
      endpointStates: {
        alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      },
      conflictCount: 0,
      lastCycleObservedAtMs: null,
      unexpected: true,
    }).success).toBe(false);

    expect(WorkspaceSyncRuntimeEventV1Schema.parse({
      v: 1,
      readiness: {
        engine: { state: 'ready' },
        carrier: { state: 'unavailable', errorCode: 'machine_carrier_unavailable' },
      },
      status: {
        relationshipId: 'rel-1',
        controllerMachineId: 'machine-a',
        state: 'paused',
        alphaPath: '/repo/a',
        betaPath: '/repo/b',
        mode: 'keep_synced',
        endpointStates: {
          alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
          beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        },
        conflictCount: 0,
        lastCycleObservedAtMs: null,
      },
    })).toMatchObject({
      v: 1,
      readiness: {
        engine: { state: 'ready' },
        carrier: { state: 'unavailable', errorCode: 'machine_carrier_unavailable' },
      },
      status: { state: 'paused' },
    });
    expect(WorkspaceSyncRuntimeEventV1Schema.parse({
      v: 1,
      readiness: {
        engine: { state: 'unavailable', errorCode: 'engine_unavailable' },
        carrier: { state: 'ready' },
      },
    })).toEqual({
      v: 1,
      readiness: {
        engine: { state: 'unavailable', errorCode: 'engine_unavailable' },
        carrier: { state: 'ready' },
      },
    });
    expect(WorkspaceSyncRuntimeEventV1Schema.safeParse({
      v: 1,
      readiness: {
        engine: { state: 'ready' },
        carrier: { state: 'ready' },
      },
      status: {
        relationshipId: 'rel-1',
        controllerMachineId: 'machine-a',
        state: 'paused',
        alphaPath: '/repo/a',
        betaPath: '/repo/b',
        mode: 'keep_synced',
        endpointStates: { alpha: null, beta: null },
        conflictCount: 0,
        lastCycleObservedAtMs: null,
      },
      unexpected: true,
    }).success).toBe(false);
  });

  it('bounds workspace conflict file previews and keeps result variants body-safe', () => {
    expect(ReadWorkspaceSyncFileV1Schema.parse({
      relationshipId: 'rel-1',
      side: 'alpha',
      path: 'src/index.ts',
    })).toMatchObject({ maxBytes: 1024 * 1024 });
    expect(ReadWorkspaceSyncFileV1Schema.safeParse({
      relationshipId: 'rel-1',
      side: 'beta',
      path: 'src/index.ts',
      maxBytes: 1024 * 1024 + 1,
    }).success).toBe(false);
    expect(ReadWorkspaceSyncFileResultV1Schema.parse({
      status: 'text',
      text: 'hello',
      digest: 'a'.repeat(40),
      size: 5,
    })).toMatchObject({ status: 'text', text: 'hello' });
    expect(ReadWorkspaceSyncFileResultV1Schema.safeParse({
      status: 'binary',
      bytes: 'must-not-cross-the-status-boundary',
      digest: 'a'.repeat(40),
      size: 5,
    }).success).toBe(false);
  });

  it('preserves exact engine-relative path text while rejecting universally unsafe components', () => {
    const spacedPath = ' nested/ note.txt ';
    expect(WorkspaceSyncConflictListV1Schema.parse({
      relationshipId: 'rel-1',
      totalCount: 1,
      shownCount: 1,
      truncatedCount: 0,
      conflicts: [{
        relationshipId: 'rel-1',
        path: spacedPath,
        alpha: { kind: 'file', digest: 'a'.repeat(40), size: 4 },
        beta: { kind: 'file', digest: 'b'.repeat(40), size: 4 },
      }],
    }).conflicts[0]?.path).toBe(spacedPath);
    expect(ReadWorkspaceSyncFileV1Schema.parse({
      relationshipId: 'rel-1',
      side: 'alpha',
      path: spacedPath,
    }).path).toBe(spacedPath);
    expect(WorkspaceSyncConflictResolutionV1Schema.parse({
      controllerMachineId: 'machine-controller', hubWorkspaceRefId: 'workspace-alpha', path: spacedPath,
      source: { workspaceRefId: 'workspace-alpha', expected: { kind: 'missing' } },
      targets: [{ workspaceRefId: 'workspace-beta', expected: { kind: 'missing' } }],
      relationshipIds: ['rel-1'], strategy: 'use_source',
    }).path).toBe(spacedPath);

    for (const path of ['', '.', '..', '/absolute', 'nested//file', 'nested/./file', 'nested/../file', 'nested/file\0tail']) {
      expect(ReadWorkspaceSyncFileV1Schema.safeParse({
        relationshipId: 'rel-1',
        side: 'alpha',
        path,
      }).success).toBe(false);
    }

    // Backslash is filename data on POSIX. The target platform's confinement
    // owner applies Windows separator and absolute-path rules when applicable.
    expect(ReadWorkspaceSyncFileV1Schema.parse({
      relationshipId: 'rel-1',
      side: 'alpha',
      path: String.raw`nested\..\note.txt`,
    }).path).toBe(String.raw`nested\..\note.txt`);
  });


  it('requires an exact persisted Action receipt envelope for the controller conflict RPC', () => {
    const file = { kind: 'file' as const, digest: 'a'.repeat(40), executable: false, size: 5 };
    const envelope = {
      actionReceiptId: 'approved-action-artifact-1',
      actionInput: {
        controllerMachineId: 'machine-controller',
        hubWorkspaceRefId: 'workspace-alpha',
        path: 'src/index.ts',
        source: { workspaceRefId: 'workspace-alpha', expected: file },
        targets: [{ workspaceRefId: 'workspace-beta', expected: { kind: 'missing' as const } }],
        relationshipIds: ['rel-1'],
        strategy: 'use_source' as const,
      },
    };
    expect(WorkspaceSyncConflictResolveRpcInputV1Schema.parse(envelope)).toEqual(envelope);
    expect(WorkspaceSyncConflictResolveRpcInputV1Schema.safeParse(envelope.actionInput).success).toBe(false);
    expect(WorkspaceSyncConflictResolveRpcInputV1Schema.safeParse({ ...envelope, approved: true }).success).toBe(false);
  });


  it('keeps target file-read authority workspace-ref scoped and root-free', () => {
    expect(WorkspaceSyncTargetFileReadV1Schema.parse({
      relationshipId: 'rel-1',
      workspaceRefId: 'workspace-beta',
      path: 'src/index.ts',
    })).toMatchObject({
      relationshipId: 'rel-1',
      workspaceRefId: 'workspace-beta',
      maxBytes: 1024 * 1024,
    });
    expect(WorkspaceSyncTargetFileReadV1Schema.safeParse({
      relationshipId: 'rel-1',
      workspaceRefId: 'workspace-beta',
      rootPath: '/caller/chosen/root',
      path: 'src/index.ts',
    }).success).toBe(false);
    expect(WorkspaceSyncTargetFileReadV1Schema.safeParse({
      relationshipId: 'rel-1',
      side: 'beta',
      path: 'src/index.ts',
    }).success).toBe(false);
  });

  it('rejects non-versioned or malformed content policies', () => {
    expect(WorkspaceContentPolicyV1Schema.safeParse({ ...contentPolicy, v: 2 }).success).toBe(false);
    expect(WorkspaceContentPolicyV1Schema.safeParse({
      ...contentPolicy,
      extraIgnorePatterns: [''],
    }).success).toBe(false);
    expect(WorkspaceContentPolicyV1Schema.safeParse({ ...contentPolicy, policyDigest: '0'.repeat(64) }).success).toBe(false);
  });

  it('requires safe integer relationship timestamps', () => {
    const relationship = {
      v: 1 as const, relationshipId: 'rel-1', controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'workspace-a', betaWorkspaceRefId: 'workspace-b', mode: 'keep_synced' as const,
      contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 2,
    };
    expect(WorkspaceSyncRelationshipV1Schema.safeParse({ ...relationship, createdAtMs: 1.5 }).success).toBe(false);
    expect(WorkspaceSyncRelationshipV1Schema.safeParse({ ...relationship, updatedAtMs: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });

  it('accepts strict root-free target bootstrap prepare requests for both owner kinds', () => {
    const relationshipPrepare = {
      v: 1 as const,
      bootstrapOperationId: 'bootstrap-op-1',
      owner: { kind: 'relationship' as const, relationshipId: 'rel-1' },
      targetWorkspaceRefId: 'workspace-beta',
      endpointRole: 'beta' as const,
      policyDigest: 'a'.repeat(64),
      createIfMissing: true,
    };
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.parse(relationshipPrepare)).toEqual(relationshipPrepare);
    const copyOnceOperation = {
      v: 1 as const,
      operationId: 'copy-op-1',
      controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'workspace-alpha',
      betaWorkspaceRefId: 'workspace-beta',
      contentPolicy,
    };
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.parse({
      ...relationshipPrepare,
      bootstrapOperationId: 'bootstrap-op-2',
      owner: { kind: 'copy_once' as const, operation: copyOnceOperation },
      targetBootstrap: 'materialize_from_source_workspace',
    }).owner).toEqual({ kind: 'copy_once', operation: copyOnceOperation });
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse({
      ...relationshipPrepare,
      bootstrapOperationId: 'bootstrap-op-3',
      owner: { kind: 'copy_once' as const, operation: copyOnceOperation },
      targetBootstrap: 'use_existing',
      destructiveTargetReuseApproved: true,
    }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.parse({
      ...relationshipPrepare,
      bootstrapOperationId: 'copy-op-1',
      owner: { kind: 'copy_once' as const, operation: copyOnceOperation },
      createIfMissing: false,
    }).targetBootstrap).toBeUndefined();
  });

  it('rejects caller-supplied paths, credentials, routes and every unknown prepare field', () => {
    const relationshipPrepare = {
      v: 1 as const,
      bootstrapOperationId: 'bootstrap-op-1',
      owner: { kind: 'relationship' as const, relationshipId: 'rel-1' },
      targetWorkspaceRefId: 'workspace-beta',
      endpointRole: 'beta' as const,
      policyDigest: 'a'.repeat(64),
      createIfMissing: true,
    };
    for (const poison of [
      'rootPath', 'sourceRootPath', 'canonicalRoot', 'markerPath', 'credential', 'grant', 'bearer', 'route', 'unknownField',
    ] as const) {
      const poisoned = { ...relationshipPrepare, [poison]: '/caller/chosen/value' } as Record<string, unknown>;
      expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse(poisoned).success).toBe(false);
    }
  });

  it('rejects malformed target bootstrap prepare contracts', () => {
    const relationshipPrepare = {
      v: 1 as const,
      bootstrapOperationId: 'bootstrap-op-1',
      owner: { kind: 'relationship' as const, relationshipId: 'rel-1' },
      targetWorkspaceRefId: 'workspace-beta',
      endpointRole: 'beta' as const,
      policyDigest: 'a'.repeat(64),
      createIfMissing: true,
    };
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse({ ...relationshipPrepare, v: 2 }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse({ ...relationshipPrepare, endpointRole: 'source' }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse({ ...relationshipPrepare, policyDigest: 'A'.repeat(64) }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse({ ...relationshipPrepare, policyDigest: 'a'.repeat(63) }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse({ ...relationshipPrepare, bootstrapOperationId: '   ' }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse({
      ...relationshipPrepare,
      owner: { kind: 'machine', machineId: 'machine-a' },
    }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse({
      ...relationshipPrepare,
      owner: {
        kind: 'copy_once',
        operation: {
          v: 1,
          operationId: 'copy-op-1',
          controllerMachineId: 'machine-a',
          alphaWorkspaceRefId: 'workspace-alpha',
          betaWorkspaceRefId: 'workspace-beta',
          contentPolicy: { ...contentPolicy, policyDigest: 'b'.repeat(64) },
        },
      },
    }).success).toBe(false);
  });

  it('keeps the target bootstrap prepare result strict, hex-digested and free of paths or handles', () => {
    const result = {
      v: 1,
      bootstrapOperationId: 'bootstrap-op-1',
      targetWorkspaceRefId: 'workspace-beta',
      state: 'ready',
      created: true,
      rootFingerprint: 'b'.repeat(64),
      policyDigest: 'a'.repeat(64),
    };
    expect(WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(result)).toEqual(result);
    expect(WorkspaceSyncTargetBootstrapPrepareResultV1Schema.safeParse({ ...result, rootPath: '/leaked/path' }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapPrepareResultV1Schema.safeParse({ ...result, handle: { ownerId: 'leaked' } }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapPrepareResultV1Schema.safeParse({ ...result, manifestDigest: 'c'.repeat(64) }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapPrepareResultV1Schema.safeParse({ ...result, state: 'READY' }).success).toBe(false);
  });

  it('admits one exact transient relationship only on its matching relationship bootstrap owner', () => {
    const transientRelationship = WorkspaceSyncRelationshipV1Schema.parse({
      v: 1,
      relationshipId: 'relationship-transient',
      controllerMachineId: 'machine-alpha',
      alphaWorkspaceRefId: 'workspace-alpha',
      betaWorkspaceRefId: 'workspace-beta',
      mode: 'keep_synced',
      contentPolicy,
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const request = {
      v: 1 as const,
      bootstrapOperationId: 'relationship-transient',
      owner: { kind: 'relationship' as const, relationshipId: 'relationship-transient' },
      transientRelationship,
      targetWorkspaceRefId: 'workspace-beta',
      endpointRole: 'beta' as const,
      policyDigest: contentPolicy.policyDigest,
      createIfMissing: true,
      targetBootstrap: 'materialize_from_source_workspace' as const,
      targetReplacementApproval: {
        v: 1 as const,
        consequences: ['replace_nonempty_workspace_target'] as const,
        serverId: 'server-1',
        machineId: 'machine-beta',
        canonicalRoot: '/workspace/beta',
        rootFingerprint: 'a'.repeat(64),
        operationId: 'relationship-transient',
      },
      targetReplacementApprovalReceiptId: 'approval-receipt-1',
      targetReplacementApprovalActionInput: {
        sessionId: 'session-1',
        targetMachineId: 'machine-beta',
        targetPath: '/workspace/beta',
      },
    };

    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.parse(request)).toEqual(request);
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse({
      ...request,
      targetReplacementApprovalReceiptId: undefined,
    }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse({
      ...request,
      targetReplacementApprovalActionInput: undefined,
    }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse({
      ...request,
      owner: { kind: 'relationship', relationshipId: 'another-relationship' },
    }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse({
      ...request,
      owner: { kind: 'copy_once', operation: {
        v: 1,
        operationId: 'copy-op',
        controllerMachineId: 'machine-alpha',
        alphaWorkspaceRefId: 'workspace-alpha',
        betaWorkspaceRefId: 'workspace-beta',
        contentPolicy,
      } },
    }).success).toBe(false);
  });

  it('keeps target bootstrap release strict, bounded and idempotent-shaped', () => {
    const release = {
      v: 1 as const,
      bootstrapOperationId: 'bootstrap-op-1',
      targetWorkspaceRefId: 'workspace-beta',
      reason: 'abort' as const,
    };
    expect(WorkspaceSyncTargetBootstrapReleaseV1Schema.parse(release)).toEqual(release);
    expect(WorkspaceSyncTargetBootstrapReleaseV1Schema.parse({ ...release, reason: 'copy_committed' })).toMatchObject({ reason: 'copy_committed' });
    expect(WorkspaceSyncTargetBootstrapReleaseV1Schema.safeParse({ ...release, reason: 'committed' }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapReleaseV1Schema.safeParse({ ...release, rootPath: '/caller/root' }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse({ ok: true, released: false })).toEqual({ ok: true, released: false });
    expect(WorkspaceSyncTargetBootstrapReleaseResultV1Schema.safeParse({ ok: false, released: false }).success).toBe(false);
    expect(WorkspaceSyncTargetBootstrapReleaseResultV1Schema.safeParse({ ok: true, released: 'yes' }).success).toBe(false);
  });

  it('binds every approved destructive handoff-target consequence to one host-private proof', () => {
    const base = {
      v: 1 as const,
      serverId: 'server-1',
      machineId: 'machine-beta',
      canonicalRoot: '/workspace/beta',
      rootFingerprint: 'a'.repeat(64),
      operationId: 'handoff-action-1',
    };

    const replacement = HandoffTargetReplacementApprovalV1Schema.parse({
      ...base,
      consequences: ['replace_nonempty_workspace_target'],
    });
    const combined = HandoffTargetReplacementApprovalV1Schema.parse({
      ...base,
      consequences: ['replace_nonempty_workspace_target', 'delete_target_only_files_during_exact_mirror'],
    });
    const mirrorOnly = HandoffTargetReplacementApprovalV1Schema.parse({
      ...base,
      consequences: ['delete_target_only_files_during_exact_mirror'],
    });

    expect(sameHandoffTargetReplacementApproval(combined, combined)).toBe(true);
    expect(sameHandoffTargetReplacementApproval(combined, replacement)).toBe(false);
    expect(sameHandoffTargetReplacementApproval(replacement, mirrorOnly)).toBe(false);

    // An empty, duplicated or unordered consequence list cannot describe one
    // decision, so it is not representable.
    expect(HandoffTargetReplacementApprovalV1Schema.safeParse({ ...base, consequences: [] }).success).toBe(false);
    expect(HandoffTargetReplacementApprovalV1Schema.safeParse({
      ...base,
      consequences: ['replace_nonempty_workspace_target', 'replace_nonempty_workspace_target'],
    }).success).toBe(false);
    expect(HandoffTargetReplacementApprovalV1Schema.safeParse({
      ...base,
      consequences: ['delete_target_only_files_during_exact_mirror', 'replace_nonempty_workspace_target'],
    }).success).toBe(false);
    expect(HandoffTargetReplacementApprovalV1Schema.safeParse({
      ...base,
      consequence: 'replace_nonempty_workspace_target',
    }).success).toBe(false);
  });

  it('carries the exact-mirror activation fact into the target preflight request', () => {
    const request = {
      v: 1 as const,
      serverId: 'server-1',
      machineId: 'machine-beta',
      operationId: 'handoff-action-1',
      targetPath: '/workspace/beta',
      activatesExactMirror: true,
    };
    expect(HandoffTargetReplacementPreflightV1Schema.parse(request)).toEqual(request);
    expect(HandoffTargetReplacementPreflightV1Schema.safeParse({
      ...request,
      activatesExactMirror: 'yes',
    }).success).toBe(false);
  });

  it('carries the committed workspace outcome as one strict terminal result', () => {
    const status = {
      relationshipId: 'relationship-1',
      controllerMachineId: 'machine-alpha',
      state: 'watching' as const,
      alphaPath: '/workspace/alpha',
      betaPath: '/workspace/beta',
      mode: 'keep_synced' as const,
      endpointStates: {
        alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      },
      conflictCount: 0,
      lastCycleObservedAtMs: 1,
    };
    const created = {
      kind: 'relationship' as const,
      relationshipId: 'relationship-1',
      created: true,
      status,
    };
    expect(HandoffWorkspaceOutcomeV1Schema.parse(created)).toEqual(created);
    const reused = { ...created, created: false };
    expect(HandoffWorkspaceOutcomeV1Schema.parse(reused)).toEqual(reused);
    const copied = {
      kind: 'copied' as const,
      operationId: 'handoff-1',
      status: { ...status, mode: 'copy_once' as const },
      cleanupWarning: { code: 'workspace_sync_commit_failed', message: 'fence release failed' },
    };
    expect(HandoffWorkspaceOutcomeV1Schema.parse(copied)).toEqual(copied);
    const linked = {
      kind: 'linked_workspace' as const,
      traversed: [{ relationshipId: 'relationship-1', policyDigest: contentPolicy.policyDigest, status }],
      cleanupWarning: { code: 'workspace_sync_commit_failed', message: 'fence release failed' },
    };
    expect(HandoffWorkspaceOutcomeV1Schema.parse(linked)).toEqual(linked);
    expect(HandoffWorkspaceOutcomeV1Schema.parse({ kind: 'none' })).toEqual({ kind: 'none' });
    // `created` distinguishes a newly persisted relationship from a reused one
    // and is therefore required, and unknown fields never survive the seam.
    expect(HandoffWorkspaceOutcomeV1Schema.safeParse({
      kind: 'relationship',
      relationshipId: 'relationship-1',
    }).success).toBe(false);
    expect(HandoffWorkspaceOutcomeV1Schema.safeParse({ ...created, mutagenSessionId: 'opaque' }).success).toBe(false);
    expect(HandoffWorkspaceOutcomeV1Schema.safeParse({ kind: 'none', cleanupWarning: { code: 'x', message: 'y' } }).success).toBe(false);
  });

  it('fails closed on the retired workspaceTransfer request field', () => {
    expect(SessionHandoffStartRequestSchema.safeParse({
      sessionId: 'session-1',
      sourceMachineId: 'machine-a',
      targetMachineId: 'machine-b',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer'],
      workspaceTransfer: { enabled: true },
    }).success).toBe(false);
    expect(SessionHandoffPrepareTargetResultGetResponseSchema.safeParse({
      ok: false,
      errorCode: 'workspace_sync_update_required',
      error: 'client must update before using workspace sync',
    }).success).toBe(true);
  });
});

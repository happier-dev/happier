import { Buffer } from 'node:buffer';
import type { FileChangeEvidence, TurnChangeSet } from '@happier-dev/protocol';

import type { ScmBackendContext } from '../types.js';

export const REPOSITORY_CHECKPOINT_RECEIPT_IDS = {
  captured: 'checkpoint.captured',
  aliased: 'checkpoint.aliased',
  finalized: 'checkpoint.finalized',
  diffComputed: 'checkpoint.diff_computed',
  cleanupPruned: 'checkpoint.cleanup_pruned',
} as const;

export type RepositoryCheckpointCapturePhase = 'message-start' | 'turn-start' | 'turn-final';

export type RepositoryCheckpointRef = Readonly<{
  scopeId: string;
  encodedScope: string;
  phase: RepositoryCheckpointCapturePhase;
  checkpointId: string;
  ref: string;
}>;

export type RepositoryCheckpointRefs = Readonly<{
  scopeId: string;
  encodedScope: string;
  messageStart?: RepositoryCheckpointRef;
  turnStart?: RepositoryCheckpointRef;
  turnFinal?: RepositoryCheckpointRef;
}>;

export type RepositoryCheckpointAvailabilityReason =
  | 'not_repo'
  | 'unsupported_scm'
  | 'missing_repo_root'
  | 'command_failed'
  | 'permission_denied'
  | 'missing_git';

export type RepositoryCheckpointTurnProjectionUnavailableReason =
  | RepositoryCheckpointAvailabilityReason
  | 'missing_source'
  | 'missing_base'
  | 'missing_final'
  | 'invalid_ref'
  | 'diff_failed'
  | 'capture_failed';

export type RepositoryCheckpointAvailability =
  | Readonly<{
    available: true;
    repoRoot: string;
    mode: '.git';
  }>
  | Readonly<{
    available: false;
    reason: RepositoryCheckpointAvailabilityReason;
    message: string;
  }>;

export type RepositoryCheckpointReceiptId =
  | 'checkpoint.captured'
  | 'checkpoint.aliased'
  | 'checkpoint.finalized'
  | 'checkpoint.diff_computed'
  | 'checkpoint.cleanup_pruned';

export type RepositoryCheckpointReceipt = Readonly<{
  id: RepositoryCheckpointReceiptId;
  ref?: string;
  commitSha?: string;
  treeSha?: string;
  phase?: RepositoryCheckpointCapturePhase;
  prunedCount?: number;
  refs?: readonly string[];
}>;

export type RepositoryCheckpointCaptureRequest = Readonly<{
  context: ScmBackendContext;
  checkpointRef: RepositoryCheckpointRef;
  message?: string;
}>;

export type RepositoryCheckpointCaptureResult =
  | Readonly<{
    success: true;
    checkpointRef: RepositoryCheckpointRef;
    commitSha: string;
    treeSha: string;
    receipts: readonly RepositoryCheckpointReceipt[];
  }>
  | Readonly<{
    success: false;
    kind: 'unavailable' | 'failed';
    reason: RepositoryCheckpointAvailabilityReason | 'capture_failed';
    error: string;
    receipts: readonly RepositoryCheckpointReceipt[];
  }>;

export type RepositoryCheckpointAliasRequest = Readonly<{
  context: ScmBackendContext;
  sourceRef: RepositoryCheckpointRef;
  targetRef: RepositoryCheckpointRef;
}>;

export type RepositoryCheckpointAliasResult =
  | Readonly<{
    success: true;
    sourceRef: RepositoryCheckpointRef;
    targetRef: RepositoryCheckpointRef;
    commitSha: string;
    receipts: readonly RepositoryCheckpointReceipt[];
  }>
  | Readonly<{
    success: false;
    kind: 'unavailable' | 'failed';
    reason: RepositoryCheckpointTurnProjectionUnavailableReason;
    error: string;
    receipts: readonly RepositoryCheckpointReceipt[];
  }>;

export type RepositoryCheckpointDiffBaseRefSource =
  | 'turn_start'
  | 'message_start'
  | 'previous_final'
  | 'unavailable';

export type RepositoryCheckpointAttributionScope =
  | 'exclusive_worktree'
  | 'shared_worktree'
  | 'unknown';

export type RepositoryCheckpointDiffRequest = Readonly<{
  context: ScmBackendContext;
  baseRef: RepositoryCheckpointRef;
  finalRef: RepositoryCheckpointRef;
  baseRefSource: Exclude<RepositoryCheckpointDiffBaseRefSource, 'unavailable'>;
  attributionScope: RepositoryCheckpointAttributionScope;
}>;

export type RepositoryCheckpointDiffResult =
  | Readonly<{
    success: true;
    baseRef: RepositoryCheckpointRef;
    finalRef: RepositoryCheckpointRef;
    baseRefSource: Exclude<RepositoryCheckpointDiffBaseRefSource, 'unavailable'>;
    contentConfidence: 'exact';
    attributionScope: RepositoryCheckpointAttributionScope;
    files: readonly FileChangeEvidence[];
    receipts: readonly RepositoryCheckpointReceipt[];
  }>
  | Readonly<{
    success: false;
    kind: 'unavailable' | 'failed';
    reason: RepositoryCheckpointTurnProjectionUnavailableReason;
    error: string;
    baseRefSource: RepositoryCheckpointDiffBaseRefSource;
    contentConfidence: 'unavailable';
    attributionScope: RepositoryCheckpointAttributionScope;
    receipts: readonly RepositoryCheckpointReceipt[];
  }>;

export type RepositoryCheckpointTurnProjection = Readonly<{
  status: 'available' | 'unavailable';
  turnChangeSet: TurnChangeSet;
}>;

export type RepositoryCheckpointListedRef = Readonly<{
  ref: string;
  committedAtMs: number | null;
}>;

export type RepositoryCheckpointCleanupRequest = Readonly<{
  scopeId: string;
  refs: readonly RepositoryCheckpointListedRef[];
  nowMs?: number;
  maxAgeMs?: number;
  maxFinalizedTurns?: number;
  deleteRef: (ref: string) => Promise<void>;
}>;

export type RepositoryCheckpointCleanupResult =
  | Readonly<{
    success: true;
    prunedCount: number;
    prunedRefs: readonly string[];
    receipts: readonly RepositoryCheckpointReceipt[];
  }>
  | Readonly<{
    success: false;
    prunedCount: number;
    prunedRefs: readonly string[];
    error: string;
    receipts: readonly RepositoryCheckpointReceipt[];
  }>;

const CHECKPOINT_REF_ROOT = 'refs/happier/checkpoints';
const INVALID_GIT_REF_SUFFIX_CHARS = /[\u0000-\u0020\u007f~^:?*[\\]/;
const SUPPORTED_CHECKPOINT_CAPTURE_PHASES = new Set<RepositoryCheckpointCapturePhase>([
  'message-start',
  'turn-start',
  'turn-final',
]);
const DEFAULT_MAX_FINALIZED_TURNS = 100;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function assertSafeCheckpointId(value: string, label: string): void {
  assertNonEmpty(value, label);
  const segments = value.split('/');
  if (
    value.startsWith('/')
    || value.endsWith('/')
    || value.includes('//')
    || value === '@'
    || value.includes('..')
    || value.includes('@{')
    || INVALID_GIT_REF_SUFFIX_CHARS.test(value)
    || segments.some((segment) => (
      segment === '.'
      || segment === '..'
      || segment.startsWith('.')
      || segment.endsWith('.')
      || segment.endsWith('.lock')
    ))
  ) {
    throw new Error(`${label} is not a safe checkpoint ref id`);
  }
}

function assertSupportedCheckpointPhase(value: string): asserts value is RepositoryCheckpointCapturePhase {
  if (!SUPPORTED_CHECKPOINT_CAPTURE_PHASES.has(value as RepositoryCheckpointCapturePhase)) {
    throw new Error('checkpoint phase is not supported');
  }
}

function isOlderThan(input: {
  ref: RepositoryCheckpointListedRef;
  nowMs: number;
  maxAgeMs: number;
}): boolean {
  if (input.ref.committedAtMs === null) return false;
  return input.nowMs - input.ref.committedAtMs > input.maxAgeMs;
}

export function encodeRepositoryCheckpointScope(scopeId: string): string {
  assertNonEmpty(scopeId, 'scopeId');
  return Buffer.from(scopeId, 'utf8').toString('base64url');
}

export function buildRepositoryCheckpointScopePrefix(scopeId: string): string {
  return `${CHECKPOINT_REF_ROOT}/${encodeRepositoryCheckpointScope(scopeId)}/`;
}

export function buildRepositoryCheckpointRef(input: {
  scopeId: string;
  phase: RepositoryCheckpointCapturePhase;
  checkpointId: string;
}): RepositoryCheckpointRef {
  const encodedScope = encodeRepositoryCheckpointScope(input.scopeId);
  assertSupportedCheckpointPhase(input.phase);
  assertSafeCheckpointId(input.checkpointId, 'checkpointId');
  return {
    scopeId: input.scopeId,
    encodedScope,
    phase: input.phase,
    checkpointId: input.checkpointId,
    ref: `${CHECKPOINT_REF_ROOT}/${encodedScope}/${input.phase}/${input.checkpointId}`,
  };
}

export function buildRepositoryCheckpointRefs(input: {
  scopeId: string;
  messageId?: string;
  turnId?: string;
}): RepositoryCheckpointRefs {
  const encodedScope = encodeRepositoryCheckpointScope(input.scopeId);
  return {
    scopeId: input.scopeId,
    encodedScope,
    messageStart: input.messageId
      ? buildRepositoryCheckpointRef({
        scopeId: input.scopeId,
        phase: 'message-start',
        checkpointId: input.messageId,
      })
      : undefined,
    turnStart: input.turnId
      ? buildRepositoryCheckpointRef({
        scopeId: input.scopeId,
        phase: 'turn-start',
        checkpointId: input.turnId,
      })
      : undefined,
    turnFinal: input.turnId
      ? buildRepositoryCheckpointRef({
        scopeId: input.scopeId,
        phase: 'turn-final',
        checkpointId: input.turnId,
      })
      : undefined,
  };
}

export function parseRepositoryCheckpointRef(input: {
  scopeId: string;
  ref: string;
}): Pick<RepositoryCheckpointRef, 'encodedScope' | 'phase' | 'checkpointId' | 'ref' | 'scopeId'> | null {
  const encodedScope = encodeRepositoryCheckpointScope(input.scopeId);
  const prefix = `${CHECKPOINT_REF_ROOT}/${encodedScope}/`;
  if (!input.ref.startsWith(prefix)) return null;

  const rest = input.ref.slice(prefix.length);
  const slashIndex = rest.indexOf('/');
  if (slashIndex <= 0) return null;

  const phase = rest.slice(0, slashIndex);
  try {
    assertSupportedCheckpointPhase(phase);
  } catch {
    return null;
  }

  const checkpointId = rest.slice(slashIndex + 1);
  try {
    assertSafeCheckpointId(checkpointId, 'checkpointId');
  } catch {
    return null;
  }

  return {
    scopeId: input.scopeId,
    encodedScope,
    phase,
    checkpointId,
    ref: input.ref,
  };
}

export function resolveRepositoryCheckpointAvailability(input: {
  context: ScmBackendContext;
}): RepositoryCheckpointAvailability {
  const { detection } = input.context;
  if (!detection.isRepo) {
    return {
      available: false,
      reason: 'not_repo',
      message: 'Repository checkpoint capture is unavailable outside a source-control repository.',
    };
  }
  if (detection.mode !== '.git') {
    return {
      available: false,
      reason: 'unsupported_scm',
      message: 'Repository checkpoint capture is currently available for Git repositories only.',
    };
  }
  if (!detection.rootPath) {
    return {
      available: false,
      reason: 'missing_repo_root',
      message: 'Repository checkpoint capture requires a resolved Git repository root.',
    };
  }
  return {
    available: true,
    repoRoot: detection.rootPath,
    mode: '.git',
  };
}

export async function pruneRepositoryCheckpointRefs(
  input: RepositoryCheckpointCleanupRequest,
): Promise<RepositoryCheckpointCleanupResult> {
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxFinalizedTurns = input.maxFinalizedTurns ?? DEFAULT_MAX_FINALIZED_TURNS;
  const parsedRefs = input.refs
    .map((listedRef) => ({
      listedRef,
      parsed: parseRepositoryCheckpointRef({ scopeId: input.scopeId, ref: listedRef.ref }),
    }))
    .filter((entry): entry is {
      listedRef: RepositoryCheckpointListedRef;
      parsed: NonNullable<ReturnType<typeof parseRepositoryCheckpointRef>>;
    } => entry.parsed !== null);

  const finalizedRefs = parsedRefs
    .filter((entry) => entry.parsed.phase === 'turn-final')
    .slice()
    .sort((a, b) => (b.listedRef.committedAtMs ?? 0) - (a.listedRef.committedAtMs ?? 0));
  const prunedFinalTurnIds = new Set<string>();

  finalizedRefs.forEach((entry, index) => {
    const shouldPrune = index >= maxFinalizedTurns || isOlderThan({ ref: entry.listedRef, nowMs, maxAgeMs });
    if (shouldPrune) {
      prunedFinalTurnIds.add(entry.parsed.checkpointId);
    }
  });

  const refsToPrune = parsedRefs.filter((entry) => {
    if (entry.parsed.phase === 'turn-final') {
      return prunedFinalTurnIds.has(entry.parsed.checkpointId);
    }
    if (entry.parsed.phase === 'turn-start') {
      if (isOlderThan({ ref: entry.listedRef, nowMs, maxAgeMs })) return true;
      if (prunedFinalTurnIds.has(entry.parsed.checkpointId)) return true;
      return false;
    }
    return isOlderThan({ ref: entry.listedRef, nowMs, maxAgeMs });
  });

  const prunedRefs: string[] = [];
  for (const entry of refsToPrune) {
    try {
      await input.deleteRef(entry.listedRef.ref);
      prunedRefs.push(entry.listedRef.ref);
    } catch (error) {
      const receipts = prunedRefs.length > 0
        ? [{
          id: REPOSITORY_CHECKPOINT_RECEIPT_IDS.cleanupPruned,
          prunedCount: prunedRefs.length,
          refs: prunedRefs,
        }]
        : [];
      return {
        success: false,
        prunedCount: prunedRefs.length,
        prunedRefs,
        error: error instanceof Error ? error.message : 'Failed to prune repository checkpoint refs',
        receipts,
      };
    }
  }

  const receipts = prunedRefs.length > 0
    ? [{
      id: REPOSITORY_CHECKPOINT_RECEIPT_IDS.cleanupPruned,
      prunedCount: prunedRefs.length,
      refs: prunedRefs,
    }]
    : [];

  return {
    success: true,
    prunedCount: prunedRefs.length,
    prunedRefs,
    receipts,
  };
}

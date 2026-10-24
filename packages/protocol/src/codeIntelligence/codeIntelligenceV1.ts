import { z } from 'zod';

import { AgentProviderIdV1Schema } from '../providers/agentProviderIdsV1.js';

/**
 * Code intelligence is a daemon-owned, local-first observation domain: the daemon on one machine
 * is the only writer of its repositories, observed sessions, commit observations, analyses and
 * activity events. Clients read snapshots and resume from an event sequence cursor.
 *
 * Observation never grants control. A session discovered in a provider's store stays read-only
 * here; taking it over remains the job of the direct-sessions takeover flow.
 */

export const CodeIntelligenceWorktreeV1Schema = z
  .object({
    worktreePath: z.string().min(1),
    gitDirPath: z.string().min(1),
    isLinkedWorktree: z.boolean(),
    branch: z.string().min(1).nullable(),
    headCommit: z.string().min(1).nullable(),
    lastObservedAtMs: z.number().int().nonnegative(),
  })
  .passthrough();
export type CodeIntelligenceWorktreeV1 = z.infer<typeof CodeIntelligenceWorktreeV1Schema>;

export const CodeIntelligenceRepositoryV1Schema = z
  .object({
    repositoryId: z.string().min(1),
    displayName: z.string().min(1),
    commonDirPath: z.string().min(1),
    registeredAtMs: z.number().int().nonnegative(),
    registrationSource: z.enum(['session', 'manual']),
    worktrees: z.array(CodeIntelligenceWorktreeV1Schema),
  })
  .passthrough();
export type CodeIntelligenceRepositoryV1 = z.infer<typeof CodeIntelligenceRepositoryV1Schema>;

/**
 * Status is derived from evidence, never from the mere existence of a session file:
 * - `running`: provider-reported running, or recent transcript activity with a live provider process.
 * - `active_recently`: recent transcript activity without process evidence.
 * - `idle`: no recent activity.
 */
export const ObservedAgentSessionStatusV1Schema = z.enum(['running', 'active_recently', 'idle', 'unknown']);
export type ObservedAgentSessionStatusV1 = z.infer<typeof ObservedAgentSessionStatusV1Schema>;

export const ObservedAgentSessionV1Schema = z
  .object({
    /** Stable observation id: `${providerId}:${providerSessionId}`. */
    id: z.string().min(1),
    providerId: AgentProviderIdV1Schema,
    providerSessionId: z.string().min(1),
    title: z.string().min(1).nullable(),
    workingDirectory: z.string().min(1).nullable(),
    repositoryId: z.string().min(1).nullable(),
    worktreePath: z.string().min(1).nullable(),
    branch: z.string().min(1).nullable(),
    status: ObservedAgentSessionStatusV1Schema,
    /** Whether a live process for this provider was observed at the last sweep. */
    providerProcessObserved: z.boolean(),
    /** 0..1 confidence in `status`; process plus fresh activity is the strongest evidence. */
    confidence: z.number().min(0).max(1),
    source: z.literal('external'),
    lastActivityAtMs: z.number().int().nonnegative(),
    firstObservedAtMs: z.number().int().nonnegative(),
  })
  .passthrough();
export type ObservedAgentSessionV1 = z.infer<typeof ObservedAgentSessionV1Schema>;

export const CodeIntelligenceSymbolKindV1Schema = z.enum([
  'function',
  'method',
  'class',
  'interface',
  'type',
  'enum',
  'struct',
  'trait',
  'module',
  'constant',
]);
export type CodeIntelligenceSymbolKindV1 = z.infer<typeof CodeIntelligenceSymbolKindV1Schema>;

/**
 * Symbol facts carry their extraction accuracy so consumers never present a heuristic
 * declaration scan as compiler-grade structure.
 */
export const CodeIntelligenceExtractionAccuracyV1Schema = z.enum(['declaration_scan']);
export type CodeIntelligenceExtractionAccuracyV1 = z.infer<typeof CodeIntelligenceExtractionAccuracyV1Schema>;

export const CodeIntelligenceChangedSymbolV1Schema = z
  .object({
    filePath: z.string().min(1),
    name: z.string().min(1),
    kind: CodeIntelligenceSymbolKindV1Schema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    changeKind: z.enum(['added', 'modified', 'deleted']),
    accuracy: CodeIntelligenceExtractionAccuracyV1Schema,
  })
  .passthrough();
export type CodeIntelligenceChangedSymbolV1 = z.infer<typeof CodeIntelligenceChangedSymbolV1Schema>;

/** A file outside the commit that textually references a changed symbol at the commit revision. */
export const CodeIntelligenceImpactReferenceV1Schema = z
  .object({
    symbolName: z.string().min(1),
    filePath: z.string().min(1),
    evidence: z.literal('textual_reference'),
  })
  .passthrough();
export type CodeIntelligenceImpactReferenceV1 = z.infer<typeof CodeIntelligenceImpactReferenceV1Schema>;

export const CodeIntelligenceChangedFileV1Schema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().min(1).nullable(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed', 'unknown']),
    insertions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
    binary: z.boolean(),
  })
  .passthrough();
export type CodeIntelligenceChangedFileV1 = z.infer<typeof CodeIntelligenceChangedFileV1Schema>;

export const CodeIntelligenceRiskLevelV1Schema = z.enum(['low', 'medium', 'high', 'critical', 'unknown']);
export type CodeIntelligenceRiskLevelV1 = z.infer<typeof CodeIntelligenceRiskLevelV1Schema>;

export const CodeIntelligenceFindingSeverityV1Schema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type CodeIntelligenceFindingSeverityV1 = z.infer<typeof CodeIntelligenceFindingSeverityV1Schema>;

/** AI output starts as `suspected`; only objective evidence may move a finding further. */
export const CodeIntelligenceFindingVerificationV1Schema = z.enum([
  'suspected',
  'reproduced',
  'verified',
  'resolved',
  'false_positive',
  'needs_investigation',
]);
export type CodeIntelligenceFindingVerificationV1 = z.infer<typeof CodeIntelligenceFindingVerificationV1Schema>;

export const CodeIntelligenceFindingV1Schema = z
  .object({
    findingId: z.string().min(1),
    filePath: z.string().min(1).nullable(),
    line: z.number().int().positive().nullable(),
    symbol: z.string().min(1).nullable(),
    category: z.string().min(1).max(100),
    severity: CodeIntelligenceFindingSeverityV1Schema,
    confidence: z.number().min(0).max(1),
    explanation: z.string().min(1).max(4000),
    evidence: z.string().max(4000).nullable(),
    suggestedCorrection: z.string().max(4000).nullable(),
    verification: CodeIntelligenceFindingVerificationV1Schema,
  })
  .passthrough();
export type CodeIntelligenceFindingV1 = z.infer<typeof CodeIntelligenceFindingV1Schema>;

export const CodeIntelligenceAnalysisStatusV1Schema = z.enum([
  'queued',
  'analyzing',
  'completed',
  'failed',
  'skipped',
  'unverified',
]);
export type CodeIntelligenceAnalysisStatusV1 = z.infer<typeof CodeIntelligenceAnalysisStatusV1Schema>;

export const CodeIntelligenceCommitAnalysisV1Schema = z
  .object({
    status: CodeIntelligenceAnalysisStatusV1Schema,
    /** Machine-readable reason for `skipped`/`failed`, e.g. `remote_analysis_disabled`, `rate_limited`. */
    reason: z.string().min(1).max(200).nullable(),
    summary: z.string().max(4000).nullable(),
    riskLevel: CodeIntelligenceRiskLevelV1Schema,
    findings: z.array(CodeIntelligenceFindingV1Schema),
    providerId: z.string().min(1).nullable(),
    modelId: z.string().min(1).nullable(),
    billing: z.enum(['free', 'subscription', 'paid']).nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    estimatedCostUsd: z.number().nonnegative().nullable(),
    retryAfterMs: z.number().int().nonnegative().nullable(),
    attempts: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
  })
  .passthrough();
export type CodeIntelligenceCommitAnalysisV1 = z.infer<typeof CodeIntelligenceCommitAnalysisV1Schema>;

export const CodeIntelligenceCommitV1Schema = z
  .object({
    repositoryId: z.string().min(1),
    sha: z.string().min(7),
    /** Worktree where the commit was first observed; not proof of which agent produced it. */
    observedInWorktreePath: z.string().min(1),
    branch: z.string().min(1).nullable(),
    subject: z.string(),
    authorName: z.string(),
    committedAtMs: z.number().int().nonnegative(),
    observedAtMs: z.number().int().nonnegative(),
    parentCount: z.number().int().nonnegative(),
    /** At most the first recorded files of the commit; `changedFileCount` is the full count. */
    changedFiles: z.array(CodeIntelligenceChangedFileV1Schema),
    /** How many files the commit changed; absent when `changedFiles` is the complete list. */
    changedFileCount: z.number().int().nonnegative().optional(),
    changedSymbols: z.array(CodeIntelligenceChangedSymbolV1Schema),
    impactedReferences: z.array(CodeIntelligenceImpactReferenceV1Schema),
    /**
     * Sessions active in the same worktree when the commit was observed. Temporal and directory
     * proximity only: never presented as authorship.
     */
    plausibleSessionIds: z.array(z.string().min(1)),
    analysis: CodeIntelligenceCommitAnalysisV1Schema,
  })
  .passthrough();
export type CodeIntelligenceCommitV1 = z.infer<typeof CodeIntelligenceCommitV1Schema>;

export const CodeIntelligenceActivityKindV1Schema = z.enum([
  'repository_registered',
  'worktree_observed',
  'session_observed',
  'session_status_changed',
  'branch_changed',
  'commit_observed',
  'analysis_started',
  'analysis_completed',
  'analysis_failed',
  'analysis_skipped',
]);
export type CodeIntelligenceActivityKindV1 = z.infer<typeof CodeIntelligenceActivityKindV1Schema>;

export const CodeIntelligenceActivityEventV1Schema = z
  .object({
    /** Monotonic per-daemon-store sequence; the only ordering guarantee clients may rely on. */
    seq: z.number().int().positive(),
    kind: CodeIntelligenceActivityKindV1Schema,
    atMs: z.number().int().nonnegative(),
    repositoryId: z.string().min(1).nullable(),
    worktreePath: z.string().min(1).nullable(),
    sessionId: z.string().min(1).nullable(),
    commitSha: z.string().min(1).nullable(),
    /** Small, display-oriented facts; never transcript content or diff text. */
    data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .passthrough();
export type CodeIntelligenceActivityEventV1 = z.infer<typeof CodeIntelligenceActivityEventV1Schema>;

export const CodeIntelligenceWorkerStatusV1Schema = z
  .object({
    state: z.enum(['disabled', 'idle', 'observing', 'analyzing', 'error']),
    lastSweepAtMs: z.number().int().nonnegative().nullable(),
    lastError: z.string().max(2000).nullable(),
  })
  .passthrough();
export type CodeIntelligenceWorkerStatusV1 = z.infer<typeof CodeIntelligenceWorkerStatusV1Schema>;

export const CodeIntelligenceSnapshotRequestV1Schema = z
  .object({
    /** Return only events after this sequence; omit for the initial snapshot. */
    afterSeq: z.number().int().nonnegative().optional(),
    eventLimit: z.number().int().min(1).max(500).optional(),
    commitLimit: z.number().int().min(1).max(200).optional(),
  })
  .passthrough();
export type CodeIntelligenceSnapshotRequestV1 = z.infer<typeof CodeIntelligenceSnapshotRequestV1Schema>;

export const CodeIntelligenceSnapshotResponseV1Schema = z.union([
  z
    .object({
      ok: z.literal(true),
      worker: CodeIntelligenceWorkerStatusV1Schema,
      repositories: z.array(CodeIntelligenceRepositoryV1Schema),
      sessions: z.array(ObservedAgentSessionV1Schema),
      commits: z.array(CodeIntelligenceCommitV1Schema),
      events: z.array(CodeIntelligenceActivityEventV1Schema),
      /**
       * Resume cursor: pass it back as `afterSeq`. It is the last event returned (or the store's
       * newest sequence when nothing was pending), never past events this page did not include.
       */
      latestSeq: z.number().int().nonnegative(),
      /**
       * True when `afterSeq` precedes the oldest retained event: the client missed events that
       * retention already removed and must replace its state with this snapshot.
       */
      eventsTruncated: z.boolean(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['code_intelligence_disabled', 'invalid_request', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type CodeIntelligenceSnapshotResponseV1 = z.infer<typeof CodeIntelligenceSnapshotResponseV1Schema>;

export const CodeIntelligenceRepositoryRegisterRequestV1Schema = z
  .object({
    path: z.string().min(1).max(10_000),
  })
  .passthrough();
export type CodeIntelligenceRepositoryRegisterRequestV1 = z.infer<typeof CodeIntelligenceRepositoryRegisterRequestV1Schema>;

export const CodeIntelligenceRepositoryRegisterResponseV1Schema = z.union([
  z.object({ ok: z.literal(true), repository: CodeIntelligenceRepositoryV1Schema }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['code_intelligence_disabled', 'not_a_git_repository', 'path_not_allowed', 'invalid_request', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type CodeIntelligenceRepositoryRegisterResponseV1 = z.infer<typeof CodeIntelligenceRepositoryRegisterResponseV1Schema>;

export const CodeIntelligenceCommitAnalyzeRequestV1Schema = z
  .object({
    repositoryId: z.string().min(1),
    sha: z.string().min(7),
  })
  .passthrough();
export type CodeIntelligenceCommitAnalyzeRequestV1 = z.infer<typeof CodeIntelligenceCommitAnalyzeRequestV1Schema>;

export const CodeIntelligenceCommitAnalyzeResponseV1Schema = z.union([
  z.object({ ok: z.literal(true), commit: CodeIntelligenceCommitV1Schema }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['code_intelligence_disabled', 'commit_not_found', 'invalid_request', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type CodeIntelligenceCommitAnalyzeResponseV1 = z.infer<typeof CodeIntelligenceCommitAnalyzeResponseV1Schema>;

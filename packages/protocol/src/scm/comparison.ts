import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ActionInvokeInputProtocolSchema } from '../actions/actionInvokeInput.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ScmCommitOidSchema } from './commitPublication.js';
import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolJsonValue, type ProtocolSchemaInput, type ProtocolSchemaOutput } from '../plugins/actions/protocolComposableSchema.js';

/** Views of one comparison; Commits is available only for pending working-tree changes. */
export const SCM_COMPARISON_VIEWS = ['files', 'walkthrough', 'commits'] as const;
export type ScmComparisonView = (typeof SCM_COMPARISON_VIEWS)[number];

const identity = z.string().check(z.minLength(1));
const textEvidence = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('available') }),
  z.strictObject({ state: z.literal('unavailable'), reason: identity }),
]);

/** Selectors are inputs, never authority for captured endpoint bytes. */
const sourceIdentity = defineProtocolString({ minLength: 1 });
/** Exact immutable endpoints; unlike branch comparisons, this never selects a merge base. */
const revisionOid = projectZodProtocolSchema(ScmCommitOidSchema);
export const ScmRevisionRangeV1ProtocolSchema = defineProtocolObject({
  kind: defineProtocolLiteral('revisionRange'), baseOid: revisionOid, headOid: revisionOid,
}, { policy: 'closed' });
export type ScmRevisionRangeV1 = ProtocolSchemaOutput<typeof ScmRevisionRangeV1ProtocolSchema>;
export const ScmRevisionRangeV1Schema = asProtocolZod(ScmRevisionRangeV1ProtocolSchema);
export const ScmComparisonSourceProtocolSchema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('turnCheckpoint'), sessionId: sourceIdentity.optional(), turnId: sourceIdentity.optional(),
    checkpointReceiptId: sourceIdentity.optional(), evidenceMode: defineProtocolUnion([
      defineProtocolLiteral('checkpoint'), defineProtocolLiteral('agent_reported'), defineProtocolLiteral('reconciled'),
    ]).optional(),
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('session'), sessionId: sourceIdentity }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('workingTree') }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('branch'), head: sourceIdentity, base: sourceIdentity }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('commit'), commit: sourceIdentity, parent: sourceIdentity.optional() }, { policy: 'closed' }),
  ScmRevisionRangeV1ProtocolSchema,
  defineProtocolObject({ kind: defineProtocolLiteral('pullRequest'), locator: defineProtocolObject({
    providerId: sourceIdentity, repository: sourceIdentity, number: defineProtocolNumber({ integer: true, minimum: 1 }),
    /** Base branch tip selector, distinct from the captured diff-before merge base. */
    baseOid: sourceIdentity.optional(), headOid: sourceIdentity.optional(),
    sourceAction: ActionInvokeInputProtocolSchema.optional(),
  }, { policy: 'closed' }) }, { policy: 'closed' }),
]);
// The portable parser omits absent optional values; its admitted output is JSON even when
// a downstream exact-optional compiler reads declarations emitted by this package.
export type ScmComparisonSource = ProtocolSchemaOutput<typeof ScmComparisonSourceProtocolSchema> & Readonly<{ [key: string]: ProtocolJsonValue }>;
export const ScmComparisonSourceSchema: z.ZodMiniType<ScmComparisonSource, ProtocolSchemaInput<typeof ScmComparisonSourceProtocolSchema>> = asProtocolZod(ScmComparisonSourceProtocolSchema);

/** Selector matching shared by saved-result queries and comparison view selection. */
export function scmComparisonSourceMatches(selector: ScmComparisonSource, source: ScmComparisonSource,
  basis?: Readonly<{ baseOid?: string; headOid?: string }>): boolean {
  switch (selector.kind) {
    case 'workingTree': return source.kind === 'workingTree';
    case 'session': return source.kind === 'session' && selector.sessionId === source.sessionId;
    case 'turnCheckpoint': return source.kind === 'turnCheckpoint'
      && Boolean(selector.turnId || selector.checkpointReceiptId)
      && (!selector.turnId || source.turnId === selector.turnId)
      && (!selector.checkpointReceiptId || source.checkpointReceiptId === selector.checkpointReceiptId)
      && (!selector.evidenceMode || selector.evidenceMode === (source.evidenceMode ?? 'reconciled'));
    case 'branch': return source.kind === 'branch' && source.head === selector.head && source.base === selector.base;
    case 'commit': return source.kind === 'commit' && source.commit === selector.commit && (source.parent ?? null) === (selector.parent ?? null);
    case 'revisionRange': return source.kind === 'revisionRange' && source.baseOid === selector.baseOid && source.headOid === selector.headOid;
    case 'pullRequest': return source.kind === 'pullRequest' && source.locator.providerId === selector.locator.providerId
      && source.locator.repository === selector.locator.repository && source.locator.number === selector.locator.number
      && (!selector.locator.baseOid || selector.locator.baseOid === (basis ? basis.baseOid : source.locator.baseOid))
      && (!selector.locator.headOid || selector.locator.headOid === (basis?.headOid ?? source.locator.headOid));
  }
}

const range = z.strictObject({ startLine: z.number().check(z.int(), z.nonnegative()), lineCount: z.number().check(z.int(), z.nonnegative()) });
export const ScmChangeOccurrenceSchema = lazyZodSchema(() => z.strictObject({
  id: identity, alias: identity, path: identity, previousPath: z.optional(identity),
  beforeBlobId: z.optional(identity), afterBlobId: z.optional(identity),
  before: range, after: range, position: z.number().check(z.int(), z.nonnegative()),
  layer: z.optional(z.enum(['staged', 'unstaged', 'untracked', 'combined'])),
  evidence: z.optional(textEvidence),
}));
export type ScmChangeOccurrence = z.infer<typeof ScmChangeOccurrenceSchema>;

export const ScmComparisonFileSchema = lazyZodSchema(() => z.strictObject({
  path: identity, previousPath: z.optional(identity), changeKind: identity,
  beforeBlobId: z.optional(identity), afterBlobId: z.optional(identity),
  binary: z.nullable(z.boolean()), generated: z.boolean(), lockfile: z.boolean(),
  evidence: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('available'), unifiedDiff: z.string() }),
    z.strictObject({ state: z.literal('unavailable'), reason: identity, unifiedDiff: z.optional(z.string()) }),
  ]),
  occurrences: z.array(ScmChangeOccurrenceSchema),
}));
export type ScmComparisonFile = z.infer<typeof ScmComparisonFileSchema>;

export const ScmComparisonSchema = lazyZodSchema(() => z.strictObject({
  id: identity, source: ScmComparisonSourceSchema,
  repository: z.strictObject({ rootPath: identity }),
  endpoints: z.strictObject({ before: z.optional(identity), after: z.optional(identity) }),
  /** Pending mutation authority is distinct from the empty tree used to display a root diff. */
  commitTarget: z.optional(z.strictObject({ headOid: z.nullable(identity), ref: z.nullable(identity) })),
  /** Source-attested base tip used for PR freshness, never as the diff-before endpoint. */
  pullRequest: z.optional(z.strictObject({ baseOid: identity })),
  inventory: z.strictObject({
    state: z.enum(['complete', 'incomplete', 'unavailable']),
    files: z.array(ScmComparisonFileSchema), reasons: z.array(identity),
  }),
  freshness: z.optional(z.enum(['current', 'stale', 'unknown'])),
  attributionScope: z.optional(z.enum(['shared_worktree', 'unknown', 'no_happier_checkpoint_overlap_observed'])),
}).check(z.superRefine((value, ctx) => {
  const identities = new Map<string, string>();
  for (const [fileIndex, file] of value.inventory.files.entries()) {
    for (const [occurrenceIndex, occurrence] of file.occurrences.entries()) {
      if (identities.has(occurrence.id) || identities.has(occurrence.alias) || occurrence.path !== file.path) {
        ctx.addIssue({ code: "custom", path: ['inventory', 'files', fileIndex, 'occurrences', occurrenceIndex], message: 'Occurrence identities must be unique and match their captured file' });
      }
      identities.set(occurrence.id, occurrence.id);
      identities.set(occurrence.alias, occurrence.id);
    }
  }
  if (value.inventory.state !== 'complete' && value.inventory.reasons.length === 0) {
    ctx.addIssue({ code: "custom", path: ['inventory', 'reasons'], message: 'Missing source coverage requires an explicit reason' });
  }
})));
export type ScmComparison = z.infer<typeof ScmComparisonSchema>;

const GENERATED_PATH = /(?:^|\/)generated(?:\/|\.)|\.generated\./i;
const LOCKFILE_PATH = /(?:^|\/)(?:yarn\.lock|package-lock\.json|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Pipfile\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|uv\.lock|go\.sum)$/;

/**
 * The path-derived evidence classes of a changed file: generated output and lockfiles. One rule for
 * the host's captured inventory and for clients labelling a turn's own files, so both say the same.
 * A class only collapses and labels evidence; it never hides it.
 */
export function classifyScmChangePath(path: string): Readonly<{ generated: boolean; lockfile: boolean }> {
  return { generated: GENERATED_PATH.test(path), lockfile: LOCKFILE_PATH.test(path) };
}

/** Identity of this SCM code basis, shared by captures, caches and personal marks. */
export function buildScmComparisonIdentity(input: Readonly<{
  source: ScmComparisonSource; repositoryRootPath: string;
  beforeOid?: string; afterOid?: string; indexOid?: string;
  sessionId?: string; turnId?: string; checkpointReceiptId?: string; turnEvidenceMode?: string;
  evidenceIdentity?: string;
}>): string {
  const source = ScmComparisonSourceSchema.parse(input.source);
  const sourceIdentity = source.kind === 'turnCheckpoint'
    ? [source.kind, input.sessionId ?? source.sessionId ?? null, source.turnId ?? input.turnId ?? null,
      source.checkpointReceiptId ?? input.checkpointReceiptId ?? null, source.evidenceMode ?? input.turnEvidenceMode ?? 'checkpoint']
    : source.kind === 'pullRequest'
      ? { kind: source.kind, locator: { providerId: source.locator.providerId,
        repository: source.locator.repository, number: source.locator.number,
        ...(source.locator.sourceAction ? { action: source.locator.sourceAction.action } : {}) } }
      : source;
  const descriptor = [
    input.repositoryRootPath, sourceIdentity,
    input.beforeOid ?? null, input.afterOid ?? null, input.indexOid ?? null,
    source.kind === 'session' || source.kind === 'turnCheckpoint' ? input.sessionId ?? source.sessionId ?? null : null,
    source.kind === 'turnCheckpoint' ? source.turnId ?? input.turnId ?? null : null,
    source.kind === 'turnCheckpoint' ? source.checkpointReceiptId ?? input.checkpointReceiptId ?? null : null,
    source.kind === 'turnCheckpoint' ? source.evidenceMode ?? input.turnEvidenceMode ?? 'checkpoint' : null,
  ];
  if (input.evidenceIdentity !== undefined) descriptor.push(input.evidenceIdentity);
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(descriptor))));
}

/** Shared selector projection; model/output choices are deliberately excluded. */
export function buildScmComparisonSourceKey(input: Readonly<{
  cwd: string; source: ScmComparisonSource; sessionId?: string; turnId?: string; checkpointReceiptId?: string; turnEvidenceMode?: string;
}>): string {
  const source = ScmComparisonSourceSchema.parse(input.source);
  switch (source.kind) {
    case 'turnCheckpoint': return JSON.stringify([source.kind, source.sessionId ?? input.sessionId ?? null, source.turnId ?? input.turnId ?? null, source.checkpointReceiptId ?? input.checkpointReceiptId ?? null, source.evidenceMode ?? input.turnEvidenceMode ?? 'reconciled']);
    case 'session': return JSON.stringify([source.kind, source.sessionId]);
    case 'workingTree': return JSON.stringify([source.kind, input.cwd]);
    case 'branch': return JSON.stringify([source.kind, input.cwd, source.head, source.base]);
    case 'commit': return JSON.stringify([source.kind, input.cwd, source.commit, source.parent ?? null]);
    case 'revisionRange': return JSON.stringify([source.kind, input.cwd, source.baseOid, source.headOid]);
    case 'pullRequest': return JSON.stringify([source.kind, source.locator.providerId, source.locator.repository, source.locator.number, source.locator.baseOid ?? null, source.locator.headOid ?? null, source.locator.sourceAction ?? null]);
  }
}

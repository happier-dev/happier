import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ActionInvokeInputProtocolSchema } from '../actions/actionInvokeInput.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolJsonValue, type ProtocolSchemaInput, type ProtocolSchemaOutput } from '../plugins/actions/protocolComposableSchema.js';

const identity = z.string().min(1);
const textEvidence = z.discriminatedUnion('state', [
  z.object({ state: z.literal('available') }).strict(),
  z.object({ state: z.literal('unavailable'), reason: identity }).strict(),
]);

/** Selectors are inputs, never authority for captured endpoint bytes. */
const sourceIdentity = defineProtocolString({ minLength: 1 });
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
export const ScmComparisonSourceSchema: z.ZodType<ScmComparisonSource, ProtocolSchemaInput<typeof ScmComparisonSourceProtocolSchema>> = asProtocolZod(ScmComparisonSourceProtocolSchema);

const range = z.object({ startLine: z.number().int().nonnegative(), lineCount: z.number().int().nonnegative() }).strict();
export const ScmChangeOccurrenceSchema = lazyZodSchema(() => z.object({
  id: identity, alias: identity, path: identity, previousPath: identity.optional(),
  beforeBlobId: identity.optional(), afterBlobId: identity.optional(),
  before: range, after: range, position: z.number().int().nonnegative(),
  layer: z.enum(['staged', 'unstaged', 'untracked', 'combined']).optional(),
  evidence: textEvidence.optional(),
}).strict());
export type ScmChangeOccurrence = z.infer<typeof ScmChangeOccurrenceSchema>;

export const ScmComparisonFileSchema = lazyZodSchema(() => z.object({
  path: identity, previousPath: identity.optional(), changeKind: identity,
  beforeBlobId: identity.optional(), afterBlobId: identity.optional(),
  binary: z.boolean().nullable(), generated: z.boolean(), lockfile: z.boolean(),
  evidence: z.discriminatedUnion('state', [
    z.object({ state: z.literal('available'), unifiedDiff: z.string() }).strict(),
    z.object({ state: z.literal('unavailable'), reason: identity, unifiedDiff: z.string().optional() }).strict(),
  ]),
  occurrences: z.array(ScmChangeOccurrenceSchema),
}).strict());
export type ScmComparisonFile = z.infer<typeof ScmComparisonFileSchema>;

export const ScmComparisonSchema = lazyZodSchema(() => z.object({
  id: identity, source: ScmComparisonSourceSchema,
  repository: z.object({ rootPath: identity }).strict(),
  endpoints: z.object({ before: identity.optional(), after: identity.optional() }).strict(),
  /** Pending mutation authority is distinct from the empty tree used to display a root diff. */
  commitTarget: z.object({ headOid: identity.nullable(), ref: identity.nullable() }).strict().optional(),
  /** Source-attested base tip used for PR freshness, never as the diff-before endpoint. */
  pullRequest: z.object({ baseOid: identity }).strict().optional(),
  inventory: z.object({
    state: z.enum(['complete', 'incomplete', 'unavailable']),
    files: z.array(ScmComparisonFileSchema), reasons: z.array(identity),
  }).strict(),
  freshness: z.enum(['current', 'stale', 'unknown']).optional(),
  attributionScope: z.enum(['shared_worktree', 'unknown', 'no_happier_checkpoint_overlap_observed']).optional(),
}).strict().superRefine((value, ctx) => {
  const identities = new Map<string, string>();
  for (const [fileIndex, file] of value.inventory.files.entries()) {
    for (const [occurrenceIndex, occurrence] of file.occurrences.entries()) {
      if (identities.has(occurrence.id) || identities.has(occurrence.alias) || occurrence.path !== file.path) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inventory', 'files', fileIndex, 'occurrences', occurrenceIndex], message: 'Occurrence identities must be unique and match their captured file' });
      }
      identities.set(occurrence.id, occurrence.id);
      identities.set(occurrence.alias, occurrence.id);
    }
  }
  if (value.inventory.state !== 'complete' && value.inventory.reasons.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inventory', 'reasons'], message: 'Missing source coverage requires an explicit reason' });
  }
}));
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
  cwd: string; source: ScmComparisonSource; turnId?: string; checkpointReceiptId?: string; turnEvidenceMode?: string;
}>): string {
  const source = ScmComparisonSourceSchema.parse(input.source);
  switch (source.kind) {
    case 'turnCheckpoint': return JSON.stringify([source.kind, source.sessionId ?? null, source.turnId ?? input.turnId ?? null, source.checkpointReceiptId ?? input.checkpointReceiptId ?? null, source.evidenceMode ?? input.turnEvidenceMode ?? 'reconciled']);
    case 'session': return JSON.stringify([source.kind, source.sessionId]);
    case 'workingTree': return JSON.stringify([source.kind, input.cwd]);
    case 'branch': return JSON.stringify([source.kind, input.cwd, source.head, source.base]);
    case 'commit': return JSON.stringify([source.kind, input.cwd, source.commit, source.parent ?? null]);
    case 'pullRequest': return JSON.stringify([source.kind, source.locator.providerId, source.locator.repository, source.locator.number, source.locator.baseOid ?? null, source.locator.headOid ?? null, source.locator.sourceAction ?? null]);
  }
}

import {
  AgentDispatchStructuredInputV1Schema,
  buildComposerAttachmentDedupeKeyV1,
  COMPOSER_REFERENCE_MENTION_KIND_V1,
  ComposerAttachmentInputV1Schema,
  ComposerAttachmentResolveRequestV1,
  ComposerAttachmentResolveResultV1Schema,
  MENTION_BOUNDS,
  MENTION_KIND_V1,
  ResolvedComposerAttachmentDispatchV1Schema,
  SessionSkillCatalogListResponseV1Schema,
  SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND,
  SessionVendorPluginCatalogListResponseV1Schema,
  readComposerReferenceMentionV1,
  readMentionRefOpaqueForKindV1,
  readStructuredInputMentionSourcesV1,
  renderSessionInputContextPromptV1,
  resolveSkillCatalogItemIdentityV1,
  type ComposerAttachmentContextBlockEntryV1,
  type ComposerAttachmentInputV1,
  type ComposerAttachmentResolveResultV1,
  type ComposerAttachmentValueV1,
  type ComposerReferenceContextBlockEntryV1,
  type ComposerReferenceResolutionV1,
  type HappierStructuredInputV1,
  type MentionRefV1,
  type PluginContributionIdentityV1,
  type ResolvedComposerAttachmentDispatchV1,
  type SessionMediaItemV1,
  type StructuredInputDispatchContextV1,
} from '@happier-dev/protocol';
import {
  buildSessionReferenceContextBlockForDispatch,
} from '../prompt/sessionReferenceBlock';

/**
 * The send-time provider resolver (D-3, INV-9, R-10).
 *
 * `MentionRefV1` carries identity only, but providers need more: Codex drops any skill item
 * lacking BOTH `name` and `path`, and OpenCode uses `vendorPluginRef` verbatim as an agent
 * name and the skill's `name` in its prompt text. So provider context is reconstructed here
 * from the live session catalogs at dispatch — never from a snapshot frozen into the
 * reference when the composer wrote it, which is what INV-9 forbids.
 *
 * It is agent-neutral on purpose: one resolver produces the resolved envelope and every
 * plugin consumes it unchanged through the public `AgentSessionInput.structuredInput`
 * contract, so Codex and OpenCode can never drift into two policies (EU-D0 §4). Resolving
 * inside a plugin would additionally require publishing a resolver contract (INV-8).
 */

type MetadataRecord = Record<string, unknown>;

export type StructuredInputCatalogReaders = Readonly<{
  listSkills?: () => Promise<unknown>;
  listVendorPlugins?: () => Promise<unknown>;
}>;

export type StructuredInputResolutionDiagnostic = Readonly<{
  catalog: 'skills' | 'vendorPlugins';
  reason: 'unsupported' | 'failed' | 'malformed';
  referenceCount: number;
}>;

/** The current-generation target registry resolves only this qualified identity. */
export type StructuredInputComposerReferenceResolver = Readonly<{
  resolve(input: Readonly<{
    reference: PluginContributionIdentityV1;
    candidateId: string;
    signal: AbortSignal;
  }>): Promise<ComposerReferenceResolutionV1>;
}>;

/**
 * The durable envelope is still identity-only. This transient block is appended
 * to the current Provider prompt at the dispatch choke point and is never
 * written back to `structuredInput`.
 */
export type StructuredInputProviderDispatchContext = StructuredInputDispatchContextV1;

export class StructuredInputComposerReferenceUnavailableError extends Error {
  readonly code = 'composer_reference_unavailable';

  constructor() {
    super('Composer reference resolution is unavailable');
    this.name = 'StructuredInputComposerReferenceUnavailableError';
  }
}

/** The current-generation target registry resolves one qualified attachment group at a time. */
export type StructuredInputComposerAttachmentResolver = Readonly<{
  resolve(input: Readonly<{
    attachment: PluginContributionIdentityV1;
    request: ComposerAttachmentResolveRequestV1<ComposerAttachmentValueV1>;
    signal: AbortSignal;
  }>): Promise<ComposerAttachmentResolveResultV1>;
}>;

type StructuredInputComposerAttachmentResolutionErrorCode =
  | 'composer_attachment_resolution_unavailable'
  | 'composer_attachment_resolution_not_found'
  | 'composer_attachment_resolution_invalid'
  | 'composer_attachment_resolution_failed'
  | 'composer_attachment_resolution_result_invalid';

/**
 * A dispatch-only attachment failure. The queue owner consumes its retryability;
 * this owner never retires or mutates the already-admitted Message.
 */
export class StructuredInputComposerAttachmentResolutionError extends Error {
  constructor(
    readonly code: StructuredInputComposerAttachmentResolutionErrorCode,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'StructuredInputComposerAttachmentResolutionError';
  }
}

export class StructuredInputComposerAttachmentUnavailableError
  extends StructuredInputComposerAttachmentResolutionError {
  constructor() {
    super(
      'composer_attachment_resolution_unavailable',
      true,
      'Composer attachment resolution is unavailable for this target',
    );
    this.name = 'StructuredInputComposerAttachmentUnavailableError';
  }
}

type StructuredInputSessionMediaProjectionErrorCode =
  | 'session_media_reference_invalid'
  | 'session_media_video_unsupported';

/**
 * SessionMedia is durable and renderable independently of Agent input support.
 * This error only rejects the pre-turn Agent projection; it never mutates or
 * degrades the already-admitted SessionMedia envelope.
 */
export class StructuredInputSessionMediaProjectionError extends Error {
  constructor(
    readonly code: StructuredInputSessionMediaProjectionErrorCode,
    readonly retryable: false,
    message: string,
  ) {
    super(message);
    this.name = 'StructuredInputSessionMediaProjectionError';
  }
}

/**
 * D-27: a known skill or vendor reference the catalog positively does not contain rejects the
 * send rather than silently sending a message whose references vanished. It is deliberately
 * NOT raised when the catalog could not be read at all — D-27 forbids reporting a resolver
 * failure as "reference not found".
 */
export class StructuredInputMentionResolutionError extends Error {
  readonly code = 'mention_reference_unresolved';
  readonly unresolvedRefs: readonly string[];

  constructor(unresolvedRefs: readonly string[]) {
    super(`Unresolved composer reference(s): ${unresolvedRefs.join(', ')}`);
    this.name = 'StructuredInputMentionResolutionError';
    this.unresolvedRefs = unresolvedRefs;
  }
}

/**
 * The resolved provider context consists of the Session tool hint, public composer-reference
 * block, and the exact skill/vendor records a provider consumes. The dispatch owner sees all
 * of those projections together, so it is the only place that can enforce one message budget.
 */
export class ResolvedMentionContextTooLargeError extends Error {
  readonly code = 'mention_resolved_context_too_large' as const;

  constructor(
    readonly totalChars: number,
    readonly maxChars: number,
  ) {
    super(
      `Resolved composer reference context is ${totalChars} characters, over the ${maxChars} `
      + 'character limit for one message. Remove some references and send again.',
    );
    this.name = 'ResolvedMentionContextTooLargeError';
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function contextCharacterLength(value: string): number {
  return Array.from(value).length;
}

function resolvedRecordsContextCharacterLength(records: readonly MetadataRecord[]): number {
  return records.length > 0 ? contextCharacterLength(JSON.stringify(records)) : 0;
}

type CatalogRead<TItem> =
  | Readonly<{ ok: true; items: readonly TItem[] }>
  | Readonly<{ ok: false; reason: StructuredInputResolutionDiagnostic['reason'] }>;

async function readCatalog<TItem>(
  read: (() => Promise<unknown>) | undefined,
  parse: (value: unknown) => Readonly<{ items: readonly TItem[]; unsupported: boolean }> | null,
): Promise<CatalogRead<TItem>> {
  if (typeof read !== 'function') return { ok: false, reason: 'unsupported' };
  let raw: unknown;
  try {
    raw = await read();
  } catch {
    return { ok: false, reason: 'failed' };
  }
  const parsed = parse(raw);
  if (!parsed) return { ok: false, reason: 'malformed' };
  if (parsed.unsupported) return { ok: false, reason: 'unsupported' };
  return { ok: true, items: parsed.items };
}

/**
 * Backends report "this catalog does not exist here" as either `unsupported: true` or
 * `supported: false`. Reading the latter as an empty catalog would make every reference look
 * positively absent and reject the send (D-27).
 */
function readCatalogUnsupported(value: Readonly<{ unsupported?: unknown; supported?: unknown }>): boolean {
  return value.unsupported === true || value.supported === false;
}

function parseSkillCatalog(value: unknown) {
  const parsed = SessionSkillCatalogListResponseV1Schema.safeParse(value);
  if (!parsed.success) return null;
  return { items: parsed.data.skills, unsupported: readCatalogUnsupported(parsed.data) };
}

function parseVendorPluginCatalog(value: unknown) {
  const parsed = SessionVendorPluginCatalogListResponseV1Schema.safeParse(value);
  if (!parsed.success) return null;
  return { items: parsed.data.vendorPlugins, unsupported: readCatalogUnsupported(parsed.data) };
}

/**
 * The legacy per-kind record the composer writes for this catalog item, reproduced field for
 * field (`apps/ui/.../structuredInputMentions.ts` `canonicalizeSkillMentionForWrite` /
 * `buildEnvelope`). R-10's bar is behavioural identity for every consumer, and a consumer
 * reading a field the resolver dropped would diverge silently.
 */
function buildSkillMentionRecord(item: MetadataRecord): MetadataRecord {
  const name = readString(item.name);
  const origin = readString(item.origin);
  if (!name) return {};
  const path = readString(item.path);
  const displayName = readString(item.displayName);
  const description = readString(item.description);
  const projectionKind = readString(item.projectionKind);
  const projectionRef = readString(item.projectionRef);
  const backendId = readString(item.backendId);
  const agentId = readString(item.agentId);
  return {
    name,
    ...(path ? { path } : {}),
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(origin ? { origin } : {}),
    ...(projectionKind ? { projectionKind } : {}),
    ...(projectionRef ? { projectionRef } : {}),
    ...(backendId ? { backendId } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

function buildVendorPluginMentionRecord(item: MetadataRecord): MetadataRecord {
  const vendorPluginRef = readString(item.vendorPluginRef);
  if (!vendorPluginRef) return {};
  // The composer's row label, reproduced exactly: Codex displays `label ?? displayName ??
  // name ?? path`, so a resolver that skipped `label` would change the displayed name.
  const label = readString(item.displayName) ?? readString(item.name);
  const backendId = readString(item.backendId);
  const agentId = readString(item.agentId);
  return {
    vendorPluginRef,
    ...(label ? { label } : {}),
    ...(backendId ? { backendId } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

/**
 * D-26: every textual occurrence stays in `mentions[]` because range reconciliation needs it,
 * but provider context is deduplicated by `{kind, ref}` and ordered by first occurrence — the
 * same order and multiplicity the legacy per-kind arrays had.
 */
function collectReferencedOpaques(
  mentions: readonly MentionRefV1[],
  kind: typeof MENTION_KIND_V1.skill | typeof MENTION_KIND_V1.vendorPlugin,
): ReadonlyArray<Readonly<{ ref: string; opaque: string }>> {
  const out: Array<Readonly<{ ref: string; opaque: string }>> = [];
  const seen = new Set<string>();
  for (const mention of mentions) {
    if (mention.kind !== kind) continue;
    if (seen.has(mention.ref)) continue;
    const opaque = readMentionRefOpaqueForKindV1(kind, mention.ref);
    if (opaque === null) continue;
    seen.add(mention.ref);
    out.push({ ref: mention.ref, opaque });
  }
  return out;
}

async function resolveKind(params: Readonly<{
  references: ReadonlyArray<Readonly<{ ref: string; opaque: string }>>;
  read: (() => Promise<unknown>) | undefined;
  parse: (value: unknown) => Readonly<{ items: readonly unknown[]; unsupported: boolean }> | null;
  indexBy: (item: MetadataRecord) => string | null;
  build: (item: MetadataRecord) => MetadataRecord;
  catalog: StructuredInputResolutionDiagnostic['catalog'];
  unresolved: string[];
  onDiagnostic?: (diagnostic: StructuredInputResolutionDiagnostic) => void;
}>): Promise<MetadataRecord[]> {
  if (params.references.length === 0) return [];
  const catalog = await readCatalog(params.read, params.parse);
  if (!catalog.ok) {
    params.onDiagnostic?.({ catalog: params.catalog, reason: catalog.reason, referenceCount: params.references.length });
    return [];
  }

  const byIdentity = new Map<string, MetadataRecord>();
  for (const item of catalog.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as MetadataRecord;
    const identity = params.indexBy(record);
    if (!identity || byIdentity.has(identity)) continue;
    byIdentity.set(identity, record);
  }

  const resolved: MetadataRecord[] = [];
  for (const reference of params.references) {
    const item = byIdentity.get(reference.opaque);
    const record = item ? params.build(item) : {};
    if (Object.keys(record).length === 0) {
      params.unresolved.push(reference.ref);
      continue;
    }
    resolved.push(record);
  }
  return resolved;
}

type ComposerReferenceForDispatch = Readonly<{
  ref: string;
  reference: PluginContributionIdentityV1;
  candidateId: string;
}>;

/**
 * The reserved Host kind has one interpretation. A malformed item with that
 * kind must fail the send rather than become an inert, silently omitted
 * current-context request. Unknown non-Host kinds keep the incumbent inert
 * compatibility behavior.
 */
function collectComposerReferences(
  mentions: readonly MentionRefV1[],
  unresolved: string[],
): readonly ComposerReferenceForDispatch[] {
  const references: ComposerReferenceForDispatch[] = [];
  const seen = new Set<string>();
  for (const mention of mentions) {
    if (mention.kind !== COMPOSER_REFERENCE_MENTION_KIND_V1) continue;
    const parsed = readComposerReferenceMentionV1(mention);
    if (!parsed) {
      unresolved.push(mention.ref);
      continue;
    }
    const key = JSON.stringify([
      parsed.reference.pluginId,
      parsed.reference.localId,
      parsed.candidateId,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(Object.freeze({
      ref: mention.ref,
      reference: parsed.reference,
      candidateId: parsed.candidateId,
    }));
  }
  return Object.freeze(references);
}

async function resolveComposerReferences(params: Readonly<{
  references: readonly ComposerReferenceForDispatch[];
  resolver?: StructuredInputComposerReferenceResolver;
  signal?: AbortSignal;
}>): Promise<readonly ComposerReferenceContextBlockEntryV1[]> {
  if (params.references.length === 0) return Object.freeze([]);
  if (!params.resolver || !params.signal) {
    throw new StructuredInputComposerReferenceUnavailableError();
  }

  const entries: ComposerReferenceContextBlockEntryV1[] = [];
  for (const reference of params.references) {
    params.signal.throwIfAborted();
    const resolution = await params.resolver.resolve(Object.freeze({
      reference: reference.reference,
      candidateId: reference.candidateId,
      signal: params.signal,
    }));
    params.signal.throwIfAborted();
    entries.push(Object.freeze({
      reference: reference.reference,
      candidateId: reference.candidateId,
      resolution,
    }));
  }
  return Object.freeze(entries);
}

type ComposerAttachmentResolutionGroup = Readonly<{
  attachment: PluginContributionIdentityV1;
  attachments: readonly ComposerAttachmentInputV1[];
}>;

type ResolvedComposerAttachmentProjection = Readonly<{
  attachments: readonly ResolvedComposerAttachmentDispatchV1[];
  contextEntries: readonly ComposerAttachmentContextBlockEntryV1[];
}>;

function composerAttachmentResolutionError(params: Readonly<{
  code: StructuredInputComposerAttachmentResolutionErrorCode;
  retryable: boolean;
  message: string;
}>): StructuredInputComposerAttachmentResolutionError {
  return new StructuredInputComposerAttachmentResolutionError(
    params.code,
    params.retryable,
    params.message,
  );
}

/**
 * Persisted structured input normally arrives from the canonical admission owner, but this
 * dispatch boundary still rejects malformed or duplicate raw records rather than silently
 * dropping one and dispatching its sibling.
 */
function readComposerAttachmentsForDispatch(
  envelope: HappierStructuredInputV1,
): readonly ComposerAttachmentInputV1[] {
  const record = envelope as unknown as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'composerAttachments')) {
    return Object.freeze([]);
  }
  if (!Array.isArray(record.composerAttachments)) {
    throw composerAttachmentResolutionError({
      code: 'composer_attachment_resolution_invalid',
      retryable: false,
      message: 'Composer attachment input is invalid',
    });
  }
  const attachments: ComposerAttachmentInputV1[] = [];
  const instanceIds = new Set<string>();
  const semanticAttachmentKeys = new Set<string>();
  for (const rawAttachment of record.composerAttachments) {
    const parsed = ComposerAttachmentInputV1Schema.safeParse(rawAttachment);
    if (!parsed.success) {
      throw composerAttachmentResolutionError({
        code: 'composer_attachment_resolution_invalid',
        retryable: false,
        message: 'Composer attachment input is invalid',
      });
    }
    const semanticKey = buildComposerAttachmentDedupeKeyV1(parsed.data.attachment, parsed.data.key);
    if (instanceIds.has(parsed.data.instanceId) || semanticAttachmentKeys.has(semanticKey)) {
      throw composerAttachmentResolutionError({
        code: 'composer_attachment_resolution_invalid',
        retryable: false,
        message: 'Composer attachment input is invalid',
      });
    }
    instanceIds.add(parsed.data.instanceId);
    semanticAttachmentKeys.add(semanticKey);
    attachments.push(parsed.data);
  }
  return Object.freeze(attachments);
}

function groupComposerAttachmentsForDispatch(
  attachments: readonly ComposerAttachmentInputV1[],
): readonly ComposerAttachmentResolutionGroup[] {
  const groups = new Map<string, {
    attachment: PluginContributionIdentityV1;
    attachments: ComposerAttachmentInputV1[];
  }>();
  for (const attachment of attachments) {
    const key = `${attachment.attachment.pluginId}\u0000${attachment.attachment.localId}`;
    const group = groups.get(key);
    if (group) {
      group.attachments.push(attachment);
      continue;
    }
    groups.set(key, {
      attachment: attachment.attachment,
      attachments: [attachment],
    });
  }
  return Object.freeze([...groups.values()].map((group) => Object.freeze({
    attachment: group.attachment,
    attachments: Object.freeze(group.attachments),
  })));
}

function correlateComposerAttachmentResolution(params: Readonly<{
  attachment: PluginContributionIdentityV1;
  requested: readonly ComposerAttachmentInputV1[];
  result: unknown;
}>): readonly ComposerAttachmentResolveResultV1['attachments'][number][] {
  const parsed = ComposerAttachmentResolveResultV1Schema.safeParse(params.result);
  if (!parsed.success || parsed.data.attachments.length !== params.requested.length) {
    throw composerAttachmentResolutionError({
      code: 'composer_attachment_resolution_result_invalid',
      retryable: true,
      message: `Composer attachment '${params.attachment.pluginId}/${params.attachment.localId}' returned an invalid resolution`,
    });
  }
  const requestedIds = new Set(params.requested.map((attachment) => attachment.instanceId));
  const byInstanceId = new Map<string, ComposerAttachmentResolveResultV1['attachments'][number]>();
  for (const outcome of parsed.data.attachments) {
    if (!requestedIds.has(outcome.instanceId) || byInstanceId.has(outcome.instanceId)) {
      throw composerAttachmentResolutionError({
        code: 'composer_attachment_resolution_result_invalid',
        retryable: true,
        message: `Composer attachment '${params.attachment.pluginId}/${params.attachment.localId}' returned an invalid resolution`,
      });
    }
    byInstanceId.set(outcome.instanceId, outcome);
  }
  const ordered: ComposerAttachmentResolveResultV1['attachments'][number][] = [];
  for (const requested of params.requested) {
    const outcome = byInstanceId.get(requested.instanceId);
    if (!outcome) {
      throw composerAttachmentResolutionError({
        code: 'composer_attachment_resolution_result_invalid',
        retryable: true,
        message: `Composer attachment '${params.attachment.pluginId}/${params.attachment.localId}' returned an invalid resolution`,
      });
    }
    ordered.push(outcome);
  }
  return Object.freeze(ordered);
}

function nonReadyComposerAttachmentResolutionError(
  outcome: Exclude<ComposerAttachmentResolveResultV1['attachments'][number], Readonly<{ status: 'ready' }>>,
): StructuredInputComposerAttachmentResolutionError {
  const code = outcome.status === 'notFound'
    ? 'composer_attachment_resolution_not_found'
    : `composer_attachment_resolution_${outcome.status}` as const;
  return composerAttachmentResolutionError({
    code,
    retryable: outcome.retryable,
    message: outcome.message ?? `Composer attachment resolution is ${outcome.status}`,
  });
}

async function resolveComposerAttachments(params: Readonly<{
  attachments: readonly ComposerAttachmentInputV1[];
  resolver?: StructuredInputComposerAttachmentResolver;
  sessionId?: string;
  localId?: string;
  signal?: AbortSignal;
}>): Promise<ResolvedComposerAttachmentProjection> {
  if (params.attachments.length === 0) {
    return Object.freeze({ attachments: Object.freeze([]), contextEntries: Object.freeze([]) });
  }
  if (!params.resolver || !params.sessionId || !params.localId || !params.signal) {
    throw new StructuredInputComposerAttachmentUnavailableError();
  }

  const resolvedByInstanceId = new Map<string, ResolvedComposerAttachmentDispatchV1>();
  const contextByInstanceId = new Map<string, ComposerAttachmentContextBlockEntryV1>();
  for (const group of groupComposerAttachmentsForDispatch(params.attachments)) {
    params.signal.throwIfAborted();
    const result = await params.resolver.resolve({
      attachment: group.attachment,
      request: Object.freeze({
        sessionId: params.sessionId,
        localId: params.localId,
        attachments: Object.freeze(group.attachments.map((attachment) => Object.freeze({
          instanceId: attachment.instanceId,
          key: attachment.key,
          value: attachment.value,
        }))),
      }),
      signal: params.signal,
    });
    params.signal.throwIfAborted();
    const outcomes = correlateComposerAttachmentResolution({
      attachment: group.attachment,
      requested: group.attachments,
      result,
    });
    outcomes.forEach((outcome, index) => {
      const attachment = group.attachments[index]!;
      if (outcome.status !== 'ready') {
        throw nonReadyComposerAttachmentResolutionError(outcome);
      }
      const { content: _content, ...contentlessAttachment } = attachment;
      const resolved = ResolvedComposerAttachmentDispatchV1Schema.parse({
          ...contentlessAttachment,
          ...(outcome.data === undefined ? {} : { data: outcome.data }),
        });
      resolvedByInstanceId.set(attachment.instanceId, resolved);
      contextByInstanceId.set(attachment.instanceId, Object.freeze({
        attachment: resolved,
        ...(outcome.context === undefined ? {} : { context: outcome.context }),
      }));
    });
  }

  const attachments = params.attachments.map((attachment) => {
    const resolved = resolvedByInstanceId.get(attachment.instanceId);
    if (!resolved) {
      throw composerAttachmentResolutionError({
        code: 'composer_attachment_resolution_result_invalid',
        retryable: true,
        message: 'Composer attachment resolution omitted a selected attachment',
      });
    }
    return resolved;
  });
  const contextEntries = params.attachments.flatMap((attachment) => {
    const entry = contextByInstanceId.get(attachment.instanceId);
    return entry ? [entry] : [];
  });
  return Object.freeze({
    attachments: Object.freeze(attachments),
    contextEntries: Object.freeze(contextEntries),
  });
}

function sessionMediaProjectionError(
  code: StructuredInputSessionMediaProjectionErrorCode,
  message: string,
): StructuredInputSessionMediaProjectionError {
  return new StructuredInputSessionMediaProjectionError(code, false, message);
}

/**
 * The queue carries only the exact SessionMedia items validated against its
 * admitted Composer refs. This dispatch owner re-checks that relationship so
 * direct callers cannot promote arbitrary workspace paths into Agent input.
 */
function projectSessionMediaImageInputs(params: Readonly<{
  attachments: readonly ComposerAttachmentInputV1[];
  sessionMedia: readonly SessionMediaItemV1[];
}>): readonly Record<string, unknown>[] {
  const referencedMediaIds = params.attachments.flatMap((attachment) => (
    attachment.content?.kind === 'sessionMedia' ? [attachment.content.mediaId] : []
  ));
  if (referencedMediaIds.length === 0) return Object.freeze([]);

  const referencedIds = new Set<string>();
  for (const mediaId of referencedMediaIds) {
    if (referencedIds.has(mediaId)) {
      throw sessionMediaProjectionError(
        'session_media_reference_invalid',
        'Composer SessionMedia references must be unique',
      );
    }
    referencedIds.add(mediaId);
  }

  const mediaById = new Map<string, SessionMediaItemV1>();
  for (const media of params.sessionMedia) {
    if (
      mediaById.has(media.id)
      || media.role !== 'input'
      || media.category !== 'attachment'
      || media.origin.source !== 'user-upload'
      || typeof media.sha256 !== 'string'
    ) {
      throw sessionMediaProjectionError(
        'session_media_reference_invalid',
        'Composer SessionMedia projection is not backed by an exact admitted input item',
      );
    }
    mediaById.set(media.id, media);
  }
  if (mediaById.size !== referencedIds.size) {
    throw sessionMediaProjectionError(
      'session_media_reference_invalid',
      'Composer SessionMedia projection does not exactly match its admitted references',
    );
  }

  const images: Record<string, unknown>[] = [];
  for (const mediaId of referencedMediaIds) {
    const media = mediaById.get(mediaId);
    if (!media) {
      throw sessionMediaProjectionError(
        'session_media_reference_invalid',
        'Composer SessionMedia projection is missing an admitted media item',
      );
    }
    if (media.mediaKind === 'video') {
      throw sessionMediaProjectionError(
        'session_media_video_unsupported',
        'The current Agent runtime does not declare video input support',
      );
    }
    if (media.mediaKind !== 'image' || !media.mimeType.startsWith('image/')) {
      throw sessionMediaProjectionError(
        'session_media_reference_invalid',
        'Composer SessionMedia image projection has an invalid media type',
      );
    }
    images.push(Object.freeze({
      id: `session-media:${media.id}`,
      kind: 'localImage',
      path: media.path,
      mimeType: media.mimeType,
      label: media.name,
      sha256: media.sha256,
      sizeBytes: media.sizeBytes,
      provenance: { kind: SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND },
    }));
  }
  return Object.freeze(images);
}

/**
 * Rewrites the envelope so what reaches a plugin is the RESOLVED model.
 *
 * `mentions[]` is removed and the per-kind arrays carry the resolved context. That is forced
 * by D-4's precedence rule, whose single owner is `readStructuredInputMentionSourcesV1`: a
 * consumer that finds `mentions` ignores the per-kind arrays entirely, so leaving `mentions`
 * in place would make the resolved arrays invisible. Removing it in the same step keeps
 * exactly one enumeration in the envelope a provider ever sees.
 *
 * An envelope with no `mentions[]` still passes through this owner: raw Composer attachment
 * selections must be resolved immediately before dispatch, then removed from the Agent-facing
 * projection. Catalog calls remain zero when there are no catalog-backed mentions.
 */
export async function resolveStructuredInputProviderDispatchContext(params: Readonly<{
  structuredInput: HappierStructuredInputV1 | null | undefined;
  /** Exact durable items read from the canonical SessionMedia message envelope. */
  sessionMedia?: readonly SessionMediaItemV1[];
  catalogs?: StructuredInputCatalogReaders;
  composerReferences?: Readonly<{
    resolve: StructuredInputComposerReferenceResolver['resolve'];
    signal: AbortSignal;
  }>;
  composerAttachments?: Readonly<{
    sessionId: string;
    localId: string;
    resolve: StructuredInputComposerAttachmentResolver['resolve'];
    signal: AbortSignal;
  }>;
  onDiagnostic?: (diagnostic: StructuredInputResolutionDiagnostic) => void;
}>): Promise<StructuredInputProviderDispatchContext> {
  const envelope = params.structuredInput;
  if (!envelope) {
    return Object.freeze({
      structuredInput: envelope,
      promptContext: Object.freeze({
        sessionReferenceBlock: '',
        composerReferences: Object.freeze([]),
        composerAttachments: Object.freeze([]),
      }),
    });
  }

  const attachments = readComposerAttachmentsForDispatch(envelope);
  const sessionMediaImageInputs = projectSessionMediaImageInputs({
    attachments,
    sessionMedia: params.sessionMedia ?? [],
  });
  const sources = readStructuredInputMentionSourcesV1(envelope);
  const catalogs = params.catalogs ?? {};
  const unresolved: string[] = [];
  const composerReferences = collectComposerReferences(sources.mentions, unresolved);
  const [skillMentions, vendorPluginMentions, composerContextEntries, attachmentProjection] = await Promise.all([
    resolveKind({
      references: collectReferencedOpaques(sources.mentions, MENTION_KIND_V1.skill),
      read: catalogs.listSkills,
      parse: parseSkillCatalog,
      indexBy: (item) => resolveSkillCatalogItemIdentityV1(item)?.id ?? null,
      build: buildSkillMentionRecord,
      catalog: 'skills',
      unresolved,
      ...(params.onDiagnostic ? { onDiagnostic: params.onDiagnostic } : {}),
    }),
    resolveKind({
      references: collectReferencedOpaques(sources.mentions, MENTION_KIND_V1.vendorPlugin),
      read: catalogs.listVendorPlugins,
      parse: parseVendorPluginCatalog,
      indexBy: (item) => readString(item.vendorPluginRef),
      build: buildVendorPluginMentionRecord,
      catalog: 'vendorPlugins',
      unresolved,
      ...(params.onDiagnostic ? { onDiagnostic: params.onDiagnostic } : {}),
    }),
    resolveComposerReferences({
      references: composerReferences,
      ...(params.composerReferences
        ? {
            resolver: Object.freeze({
              resolve: params.composerReferences.resolve,
            }),
            signal: params.composerReferences.signal,
          }
        : {}),
    }),
    resolveComposerAttachments({
      attachments,
      ...(params.composerAttachments
        ? {
            resolver: Object.freeze({
              resolve: params.composerAttachments.resolve,
            }),
            sessionId: params.composerAttachments.sessionId,
            localId: params.composerAttachments.localId,
            signal: params.composerAttachments.signal,
          }
        : {}),
    }),
  ]);

  if (unresolved.length > 0) throw new StructuredInputMentionResolutionError(unresolved);

  const sessionReferenceContextBlock =
    buildSessionReferenceContextBlockForDispatch(sources.mentions);
  const promptContext = Object.freeze({
    sessionReferenceBlock: sessionReferenceContextBlock,
    composerReferences: Object.freeze([...composerContextEntries]),
    composerAttachments: Object.freeze([...attachmentProjection.contextEntries]),
  });
  const contextBlock = renderSessionInputContextPromptV1({
    ...promptContext,
    transformedUserText: '',
  });
  const resolvedContextChars = contextCharacterLength(contextBlock)
    + resolvedRecordsContextCharacterLength(skillMentions)
    + resolvedRecordsContextCharacterLength(vendorPluginMentions);
  if (resolvedContextChars > MENTION_BOUNDS.maxResolvedContextChars) {
    throw new ResolvedMentionContextTooLargeError(
      resolvedContextChars,
      MENTION_BOUNDS.maxResolvedContextChars,
    );
  }

  const resolvedEnvelope: MetadataRecord = { ...envelope };
  // This is the only owner permitted to publish an Agent-facing resolved projection. A
  // persisted/raw envelope may be additive, so discard both the raw selection and any forged
  // pre-existing dispatch projection before parsing the exact final schema.
  delete resolvedEnvelope.composerAttachments;
  delete resolvedEnvelope.resolvedComposerAttachments;
  if (sources.mentions.length > 0) {
    // D-4's precedence owner says mentions[] wins when it is populated. Replace that raw
    // enumeration with the dispatch projection, while legacy-only envelopes remain legible
    // without a needless catalog round-trip.
    delete resolvedEnvelope.mentions;
    if (skillMentions.length > 0) {
      resolvedEnvelope.skillMentions = skillMentions;
    } else {
      delete resolvedEnvelope.skillMentions;
    }
    if (vendorPluginMentions.length > 0) {
      resolvedEnvelope.vendorPluginMentions = vendorPluginMentions;
    } else {
      delete resolvedEnvelope.vendorPluginMentions;
    }
  }
  if (attachmentProjection.attachments.length > 0) {
    resolvedEnvelope.resolvedComposerAttachments = attachmentProjection.attachments;
  }
  if (sessionMediaImageInputs.length > 0) {
    const existingImageIds = new Set((envelope.imageInputs ?? []).map((image) => image.id));
    if (sessionMediaImageInputs.some((image) => existingImageIds.has(image.id as string))) {
      throw sessionMediaProjectionError(
        'session_media_reference_invalid',
        'Composer SessionMedia image projection conflicts with an existing image input',
      );
    }
    resolvedEnvelope.imageInputs = [...(envelope.imageInputs ?? []), ...sessionMediaImageInputs];
  }
  return Object.freeze({
    structuredInput: AgentDispatchStructuredInputV1Schema.parse(resolvedEnvelope),
    promptContext,
  });
}

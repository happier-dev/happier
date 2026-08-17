import { z } from 'zod';

import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1 } from '../../plugins/interactions/transientV1.js';
import { resolveSkillCatalogOriginV1 } from '../catalog/skills.js';
import {
  SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND,
  StructuredImageInputV1Schema,
  type StructuredImageInputV1,
} from './imageInputV1.js';
import {
  ComposerAttachmentInputV1Schema,
  MAX_COMPOSER_ATTACHMENT_INSTANCES_V1,
  ResolvedComposerAttachmentDispatchV1Schema,
  type ComposerAttachmentInputV1,
  type ResolvedComposerAttachmentDispatchV1,
} from './composerAttachmentV1.js';
import type {
  ComposerAttachmentContextBlockEntryV1,
  ComposerReferenceContextBlockEntryV1,
} from './composerReferenceProviderV1.js';
import {
  MentionRefV1Schema,
  admitMentionRefsV1ForText,
  sanitizeMentionRefsV1,
  type MentionRefV1,
} from './mentionRefV1.js';
import { SkillMentionV1Schema, type SkillMentionV1 } from './skillMentionV1.js';
import { VendorPluginMentionV1Schema, type VendorPluginMentionV1 } from './vendorPluginMentionV1.js';

export const HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 = 'happierStructuredInputV1';
export const HAPPIER_VENDOR_PLUGIN_MENTIONS_METADATA_KEY = 'happierVendorPluginMentions';
export const HAPPIER_SKILL_MENTIONS_METADATA_KEY = 'happierSkillMentions';

type MetadataRecord = Record<string, unknown>;

const textEncoder = new TextEncoder();
const MAX_COMPOSER_ATTACHMENT_ENVELOPE_JSON_BYTES_V1 = MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1;

function asRecord(value: unknown): MetadataRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MetadataRecord : null;
}

function asRecordArray(value: unknown): MetadataRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((entry): entry is MetadataRecord => Boolean(entry)) : [];
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasUploadedAttachmentProvenance(value: unknown): boolean {
  return asRecord(value)?.kind === SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND;
}

export function normalizeSessionAttachmentUploadPath(value: unknown): string | null {
  const rawPath = readString(value);
  if (!rawPath || rawPath.includes('\0')) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath)) return null;

  const normalizedPath = rawPath.replace(/[\\]+/g, '/');
  const segments = normalizedPath.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;

  if (
    segments.length >= 5
    && segments[0] === '.happier'
    && segments[1] === 'uploads'
    && segments[2] === 'messages'
  ) {
    return normalizedPath;
  }

  const tempRootIndex = segments.findIndex((segment, index) =>
    segment === 'happier'
    && segments[index + 1] === 'uploads'
    && typeof segments[index + 2] === 'string'
    && segments[index + 3] === 'messages'
    && typeof segments[index + 4] === 'string'
    && typeof segments[index + 5] === 'string',
  );
  return tempRootIndex >= 0 ? normalizedPath : null;
}

function isImageInputRecord(entry: MetadataRecord): boolean {
  const kind = readString(entry.kind);
  const type = readString(entry.type);
  const mimeType = readString(entry.mimeType);
  return kind === 'image'
    || kind === 'localImage'
    || type === 'image'
    || type === 'localImage'
    || mimeType?.toLowerCase().startsWith('image/') === true;
}

function readAttachmentEnvelope(value: unknown): MetadataRecord[] {
  const envelope = asRecord(value);
  if (envelope?.kind !== 'attachments.v1') return [];
  const payload = asRecord(envelope.payload);
  return asRecordArray(payload?.attachments);
}

function readMetadataAttachmentInputs(metadata: MetadataRecord): MetadataRecord[] {
  return [
    ...readAttachmentEnvelope(metadata.happier),
    ...readAttachmentEnvelope(metadata.happierAttachments),
  ];
}

/**
 * Reads both incumbent attachment envelopes in their source order. This is
 * deliberately discovery-only: the Message admission owner remains the sole
 * validator and trust decision-maker for the returned records.
 */
export function readSessionAttachmentEnvelopeRecordsV1(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  const metadata = asRecord(value);
  return metadata ? Object.freeze([...readMetadataAttachmentInputs(metadata)]) : Object.freeze([]);
}

export function readAttachmentEnvelopeLocalImagePaths(value: unknown): ReadonlySet<string> {
  const metadata = asRecord(value);
  const paths = new Set<string>();
  if (!metadata) return paths;

  for (const attachment of readMetadataAttachmentInputs(metadata)) {
    if (!isImageInputRecord(attachment)) continue;
    const normalizedPath = normalizeSessionAttachmentUploadPath(attachment.path);
    if (normalizedPath) {
      paths.add(normalizedPath);
    }
  }

  return paths;
}

/**
 * INV-4 and §8's "no unknown element discards siblings": these normalizers run inside a zod
 * `.transform` at the request boundary, so a schema `parse` that throws here escapes
 * `safeParse` itself — one malformed element would fail the whole request with a raw
 * exception instead of being dropped on its own. Every element normalizer therefore reports
 * failure by returning `null`.
 */
function parseMentionElement<T>(
  schema: Readonly<{ safeParse: (value: unknown) => { success: true; data: T } | { success: false } }>,
  candidate: unknown,
): T | null {
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function normalizeVendorPluginMention(value: MetadataRecord): VendorPluginMentionV1 | null {
  const vendorPluginRef = readString(value.vendorPluginRef ?? value.mentionPath ?? value.path);
  if (!vendorPluginRef) return null;

  const candidate = {
    ...value,
    vendorPluginRef,
    ...(readString(value.backendId) ? { backendId: readString(value.backendId) } : {}),
    ...(readString(value.agentId) ? { agentId: readString(value.agentId) } : {}),
    ...(readString(value.label ?? value.displayName ?? value.name)
      ? { label: readString(value.label ?? value.displayName ?? value.name) }
      : {}),
  };
  return parseMentionElement(VendorPluginMentionV1Schema, candidate);
}

/**
 * The legacy origin vocabulary has ONE owner — the skill catalog schema
 * (`../catalog/skills.ts` `resolveSkillCatalogOriginV1`), which is also what produced the
 * catalog item a mention was selected from. Reading through it means the catalog half and the
 * envelope half of one round trip canonicalize a legacy payload identically, including the
 * `backendId` / `projectionRef` a `happier.skill` reference identity is derived from (D-23).
 *
 * An origin the owner cannot read is *removed* rather than guessed at. The previous local copy
 * folded any `*_native` suffix to `vendor`, which admitted tokens — `cursor_native`,
 * `gemini_native` — that the catalog schema rejects outright, so the two halves disagreed about
 * a value only one of them would ever accept.
 */
function normalizeSkillMention(value: MetadataRecord): SkillMentionV1 | null {
  const name = readString(value.name ?? value.displayName);
  if (!name) return null;

  const path = readString(value.path);
  const id = readString(value.id ?? value.projectionRef ?? path ?? name);
  const legacyOrigin = resolveSkillCatalogOriginV1(readString(value.origin));
  const label = readString(value.label ?? value.displayName);
  const projectionRef = readString(value.projectionRef) ?? legacyOrigin.projectionRef;
  const backendId = readString(value.backendId) ?? legacyOrigin.backendId;
  const candidate: MetadataRecord = {
    ...value,
    ...(id ? { id } : {}),
    name,
    ...(path ? { path } : {}),
    ...(label ? { label } : {}),
    ...(projectionRef ? { projectionRef } : {}),
    ...(backendId ? { backendId } : {}),
    ...(readString(value.agentId) ? { agentId: readString(value.agentId) } : {}),
  };
  if (legacyOrigin.origin) {
    candidate.origin = legacyOrigin.origin;
  } else {
    // `...value` would otherwise carry the unreadable origin straight into the schema, where
    // it fails the element the user actually selected.
    delete candidate.origin;
  }
  return parseMentionElement(SkillMentionV1Schema, candidate);
}

function normalizeImageInput(
  value: MetadataRecord,
  options: Readonly<{
    allowedLocalImagePaths?: ReadonlySet<string>;
    requireUploadedAttachmentProvenance: boolean;
  }>,
): StructuredImageInputV1 | null {
  if (!isImageInputRecord(value)) return null;

  const localPath = readString(value.path ?? value.localPath);
  if (localPath) {
    if (options.requireUploadedAttachmentProvenance && !hasUploadedAttachmentProvenance(value.provenance)) {
      return null;
    }
    const normalizedPath = normalizeSessionAttachmentUploadPath(localPath);
    if (!normalizedPath) return null;
    if (!options.allowedLocalImagePaths?.has(normalizedPath)) return null;
    return parseMentionElement(StructuredImageInputV1Schema, {
      ...value,
      id: readString(value.id) ?? `localImage:${normalizedPath}`,
      kind: 'localImage',
      path: normalizedPath,
      provenance: {
        ...asRecord(value.provenance),
        kind: SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND,
      },
    });
  }

  const url = readString(value.url);
  if (!url) return null;
  return parseMentionElement(StructuredImageInputV1Schema, {
    ...value,
    id: readString(value.id) ?? `image:${url}`,
    kind: 'image',
    url,
  });
}

function normalizeVendorPluginMentions(value: unknown): VendorPluginMentionV1[] {
  const mentions: VendorPluginMentionV1[] = [];
  for (const entry of asRecordArray(value)) {
    const mention = normalizeVendorPluginMention(entry);
    if (mention) mentions.push(mention);
  }
  return mentions;
}

function normalizeSkillMentions(value: unknown): SkillMentionV1[] {
  const mentions: SkillMentionV1[] = [];
  for (const entry of asRecordArray(value)) {
    const mention = normalizeSkillMention(entry);
    if (mention) mentions.push(mention);
  }
  return mentions;
}

function normalizeImageInputs(
  value: unknown,
  options: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string>; requireUploadedAttachmentProvenance: boolean }>,
): StructuredImageInputV1[] {
  const imageInputs: StructuredImageInputV1[] = [];
  for (const entry of asRecordArray(value)) {
    const imageInput = normalizeImageInput(entry, options);
    if (imageInput) imageInputs.push(imageInput);
  }
  return imageInputs;
}

/**
 * Composer attachments are structural Message records, not text-range
 * references. Preserve each valid sibling in authored order while rejecting a
 * malformed one independently, just as the incumbent mention normalizer does.
 */
function sanitizeComposerAttachmentInputs(value: unknown): ComposerAttachmentInputV1[] {
  if (!Array.isArray(value)) return [];

  const attachments: ComposerAttachmentInputV1[] = [];
  for (const entry of value) {
    if (attachments.length >= 64) break;
    const parsed = ComposerAttachmentInputV1Schema.safeParse(entry);
    if (parsed.success) attachments.push(parsed.data);
  }
  return attachments;
}

function normalizeAttachmentEnvelopeImageInputs(
  metadata: MetadataRecord,
  options: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string> }>,
): StructuredImageInputV1[] {
  const imageInputs: StructuredImageInputV1[] = [];
  for (const entry of readMetadataAttachmentInputs(metadata)) {
    const imageInput = normalizeImageInput(entry, {
      ...options,
      requireUploadedAttachmentProvenance: false,
    });
    if (imageInput) imageInputs.push(imageInput);
  }
  return imageInputs;
}

function buildImageInputKey(value: StructuredImageInputV1): string {
  if (value.kind === 'localImage') return `localImage:${value.path}`;
  if (value.kind === 'image') return `image:${value.url}`;
  return value.id;
}

function dedupeImageInputs(values: readonly StructuredImageInputV1[]): StructuredImageInputV1[] {
  const imageInputs: StructuredImageInputV1[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = buildImageInputKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    imageInputs.push(value);
  }
  return imageInputs;
}

function readComposerAttachmentEnvelopeRecords(value: unknown): readonly unknown[] {
  const envelope = asRecord(value);
  if (!envelope) return [];

  return [
    ...(Array.isArray(envelope.composerAttachments) ? envelope.composerAttachments : []),
    ...(Array.isArray(envelope.resolvedComposerAttachments) ? envelope.resolvedComposerAttachments : []),
  ];
}

/**
 * The incumbent interaction transient payload ceiling is the approved encoded
 * aggregate budget for Composer attachment records in one structured-input
 * value. Both Message admission and Agent dispatch consume this refinement so
 * neither array can bypass the other through the additive input envelope.
 */
function rejectOversizedComposerAttachmentEnvelope(
  value: unknown,
  context: z.RefinementCtx,
): void {
  const attachmentRecords = readComposerAttachmentEnvelopeRecords(value);
  if (attachmentRecords.length === 0) return;

  const encodedBytes = textEncoder.encode(createCanonicalJsonSigningInput(attachmentRecords)).byteLength;
  if (encodedBytes > MAX_COMPOSER_ATTACHMENT_ENVELOPE_JSON_BYTES_V1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Composer attachment envelopes must be at most '
        + `${MAX_COMPOSER_ATTACHMENT_ENVELOPE_JSON_BYTES_V1} canonical JSON bytes.`,
    });
  }
}

const HappierStructuredInputV1ObjectSchema = z.object({
  v: z.literal(1).default(1),
  /**
   * The open, additive reference list (R-4). It carries every composer reference kind,
   * so a new kind never needs a new per-kind array and never needs an envelope version
   * bump. Readers apply D-4 precedence through `readStructuredInputMentionSourcesV1`.
   */
  mentions: z.array(MentionRefV1Schema).optional(),
  vendorPluginMentions: z.array(VendorPluginMentionV1Schema).optional(),
  skillMentions: z.array(SkillMentionV1Schema).optional(),
  imageInputs: z.array(StructuredImageInputV1Schema).optional(),
  composerAttachments: z.array(ComposerAttachmentInputV1Schema).max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1).optional(),
}).passthrough();

export const HappierStructuredInputV1Schema = HappierStructuredInputV1ObjectSchema
  .superRefine(rejectOversizedComposerAttachmentEnvelope);

export type HappierStructuredInputV1 = z.infer<typeof HappierStructuredInputV1Schema>;

/**
 * A Message-admitted envelope has already crossed the raw ingress trust
 * boundary. Consumers distinguish its absence from invalid persisted bytes so
 * they never downgrade malformed canonical input to a legacy/text-only path.
 */
export type AdmittedHappierStructuredInputV1ReadResult = Readonly<
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'admitted'; structuredInput: HappierStructuredInputV1 }
>;

/**
 * Reads only the canonical envelope persisted by Message admission. Unlike
 * `readHappierStructuredInputV1FromMeta`, this does not sanitize raw ingress,
 * fold aliases, or re-authorize local-image paths: those decisions were made
 * once before persistence. Dispatch-only Composer data is never canonical
 * Message input and therefore fails closed here.
 */
export function readAdmittedHappierStructuredInputV1FromMeta(
  value: unknown,
): AdmittedHappierStructuredInputV1ReadResult {
  const metadata = asRecord(value);
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1)) {
    return { status: 'absent' };
  }

  const envelope = asRecord(metadata[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]);
  if (!envelope || Object.prototype.hasOwnProperty.call(envelope, 'resolvedComposerAttachments')) {
    return { status: 'invalid' };
  }
  const parsed = HappierStructuredInputV1Schema.safeParse(envelope);
  return parsed.success
    ? { status: 'admitted', structuredInput: parsed.data }
    : { status: 'invalid' };
}

/**
 * The resolved form is created only by the dispatch owner. Persisted/raw
 * composer attachments are intentionally rejected here, even though the
 * generic envelope keeps its additive-preserve behavior for Message ingress.
 */
export const AgentDispatchStructuredInputV1Schema = HappierStructuredInputV1ObjectSchema
  .omit({ composerAttachments: true })
  .extend({
    resolvedComposerAttachments: z.array(ResolvedComposerAttachmentDispatchV1Schema)
      .max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1)
      .optional(),
  })
  .superRefine((value, context) => {
    rejectOversizedComposerAttachmentEnvelope(value, context);
    if (Object.prototype.hasOwnProperty.call(value, 'composerAttachments')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['composerAttachments'],
        message: 'Agent dispatch structured input must not contain raw composer attachments.',
      });
    }
  });
export type AgentDispatchStructuredInputV1 = Readonly<
  Omit<HappierStructuredInputV1, 'composerAttachments'> & Readonly<{
    resolvedComposerAttachments?: readonly ResolvedComposerAttachmentDispatchV1[];
  }>
>;

export type StructuredInputDispatchContextV1 = Readonly<{
  structuredInput: AgentDispatchStructuredInputV1 | null | undefined;
  promptContext: Readonly<{
    sessionReferenceBlock: string;
    composerReferences: readonly ComposerReferenceContextBlockEntryV1[];
    composerAttachments: readonly ComposerAttachmentContextBlockEntryV1[];
  }>;
}>;

/**
 * Admission-only predicate for a canonical structured-input envelope. Callers
 * must first read through `readHappierStructuredInputV1FromMeta`; raw metadata
 * selections, including malformed attachment records, never satisfy this
 * predicate.
 */
export function hasAdmittedComposerAttachmentSelectionV1(
  structuredInput: HappierStructuredInputV1 | null | undefined,
): boolean {
  return (structuredInput?.composerAttachments?.length ?? 0) > 0;
}

/**
 * Raw pre-admission selection predicate for Composer attachment ingress.
 * Sanitization is intentionally not involved: a present malformed value is a
 * selected attachment attempt and must take the fail-closed admission path.
 */
export function hasRawComposerAttachmentSelectionV1(value: unknown): boolean {
  const metadata = asRecord(value);
  const envelope = metadata
    ? asRecord(metadata[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1])
    : null;
  if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'composerAttachments')) {
    return false;
  }
  const attachments = envelope.composerAttachments;
  return !Array.isArray(attachments) || attachments.length > 0;
}

const STRUCTURED_INPUT_SEMANTIC_ARRAY_FIELDS_V1 = new Set([
  'mentions',
  'vendorPluginMentions',
  'skillMentions',
  'imageInputs',
  'composerAttachments',
  // The legacy image attachment field is still read by the input normalizer,
  // so a text-only editor must not accidentally erase a selected payload.
  'attachments',
]);

/**
 * Whether a raw structured-input envelope contains semantics that a text-only
 * editor cannot reproduce. This deliberately examines the unsanitized stored
 * bytes: malformed and additive data are content until the canonical Message
 * admission owner decides otherwise.
 */
export function hasRawStructuredInputSemanticContentV1(value: unknown): boolean {
  const metadata = asRecord(value);
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1)) {
    return false;
  }
  const envelope = asRecord(metadata[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]);
  if (!envelope || envelope.v !== 1) return true;

  for (const key of Object.keys(envelope)) {
    if (key === 'v') continue;
    if (!STRUCTURED_INPUT_SEMANTIC_ARRAY_FIELDS_V1.has(key)) return true;
    const field = envelope[key];
    if (!Array.isArray(field) || field.length > 0) return true;
  }
  return false;
}

/**
 * Which reference source a consumer must enumerate (D-4). This is the single owner of the
 * precedence rule: a reader finding `mentions` uses it and ignores the legacy per-kind
 * arrays entirely; legacy is read only when `mentions` is absent.
 *
 * It deliberately does NOT mutate the envelope. The envelope keeps both shapes so a
 * dual-written message (EU-6) still reads correctly on an older build; only the decision
 * about what to enumerate is centralized, which is what removes the duplicate provider
 * items SB-5's `.concat()` produced.
 */
export type StructuredInputMentionSourcesV1 = Readonly<{
  mentions: readonly MentionRefV1[];
  // Derived from the envelope's own fields rather than from `VendorPluginMentionV1` /
  // `SkillMentionV1` directly: those two are not part of the public SDK surface, and naming
  // them here would drag them into it (declaration closure, D-9).
  vendorPluginMentions: NonNullable<HappierStructuredInputV1['vendorPluginMentions']>;
  skillMentions: NonNullable<HappierStructuredInputV1['skillMentions']>;
}>;

export function readStructuredInputMentionSourcesV1(
  envelope: HappierStructuredInputV1 | null | undefined,
): StructuredInputMentionSourcesV1 {
  const mentions = envelope?.mentions ?? [];
  if (mentions.length > 0) {
    return { mentions, vendorPluginMentions: [], skillMentions: [] };
  }
  return {
    mentions: [],
    vendorPluginMentions: envelope?.vendorPluginMentions ?? [],
    skillMentions: envelope?.skillMentions ?? [],
  };
}

function buildStructuredInputEnvelope(params: Readonly<{
  base?: MetadataRecord | null;
  mentions: readonly MentionRefV1[];
  vendorPluginMentions: readonly VendorPluginMentionV1[];
  skillMentions: readonly SkillMentionV1[];
  imageInputs: readonly StructuredImageInputV1[];
  composerAttachments: readonly ComposerAttachmentInputV1[];
}>): HappierStructuredInputV1 | null {
  if (
    !params.base
    && params.mentions.length === 0
    && params.vendorPluginMentions.length === 0
    && params.skillMentions.length === 0
    && params.imageInputs.length === 0
    && params.composerAttachments.length === 0
  ) {
    return null;
  }

  const envelope: MetadataRecord = {
    ...(params.base ?? {}),
    v: 1,
  };
  delete envelope.attachments;

  if (params.mentions.length > 0) {
    envelope.mentions = params.mentions;
  } else {
    delete envelope.mentions;
  }
  if (params.vendorPluginMentions.length > 0) {
    envelope.vendorPluginMentions = params.vendorPluginMentions;
  } else {
    delete envelope.vendorPluginMentions;
  }
  if (params.skillMentions.length > 0) {
    envelope.skillMentions = params.skillMentions;
  } else {
    delete envelope.skillMentions;
  }
  const imageInputs = dedupeImageInputs(params.imageInputs);
  if (imageInputs.length > 0) {
    envelope.imageInputs = imageInputs;
  } else {
    delete envelope.imageInputs;
  }
  if (params.composerAttachments.length > 0) {
    envelope.composerAttachments = params.composerAttachments;
  } else {
    delete envelope.composerAttachments;
  }
  // Resolution is daemon-produced only. A fallback/client sanitizer must not
  // retain an untrusted caller's claimed dispatch result through passthrough.
  delete envelope.resolvedComposerAttachments;
  return HappierStructuredInputV1Schema.parse(envelope);
}

export function sanitizeHappierStructuredInputV1(
  value: unknown,
  options: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string> }> = {},
): HappierStructuredInputV1 | null {
  const envelope = asRecord(value);
  if (!envelope) return null;

  return buildStructuredInputEnvelope({
    base: envelope,
    mentions: sanitizeMentionRefsV1(envelope.mentions),
    vendorPluginMentions: normalizeVendorPluginMentions(envelope.vendorPluginMentions),
    skillMentions: normalizeSkillMentions(envelope.skillMentions),
    imageInputs: [
      ...normalizeImageInputs(envelope.imageInputs, {
        ...options,
        requireUploadedAttachmentProvenance: true,
      }),
      ...normalizeImageInputs(envelope.attachments, {
        ...options,
        requireUploadedAttachmentProvenance: true,
      }),
    ],
    composerAttachments: sanitizeComposerAttachmentInputs(envelope.composerAttachments),
  });
}

export function readHappierStructuredInputV1FromMeta(
  value: unknown,
  options: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string> }> = {},
): HappierStructuredInputV1 | null {
  const metadata = asRecord(value);
  if (!metadata) return null;

  const structuredInput = sanitizeHappierStructuredInputV1(
    metadata[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1],
    options,
  );
  // The meta-root aliases are a legacy write shape, so they are folded into the envelope
  // here — but only when the envelope carries no `mentions`. With `mentions` present the
  // aliases are ignored entirely (D-4), which is what stops a dual-written message from
  // reaching a provider twice.
  const mentions = structuredInput?.mentions ?? [];
  const readsLegacyAliases = mentions.length === 0;
  return buildStructuredInputEnvelope({
    base: structuredInput,
    mentions,
    vendorPluginMentions: [
      ...(structuredInput?.vendorPluginMentions ?? []),
      ...(readsLegacyAliases
        ? normalizeVendorPluginMentions(metadata[HAPPIER_VENDOR_PLUGIN_MENTIONS_METADATA_KEY])
        : []),
    ],
    skillMentions: [
      ...(structuredInput?.skillMentions ?? []),
      ...(readsLegacyAliases
        ? normalizeSkillMentions(metadata[HAPPIER_SKILL_MENTIONS_METADATA_KEY])
        : []),
    ],
    imageInputs: [
      ...(structuredInput?.imageInputs ?? []),
      ...normalizeAttachmentEnvelopeImageInputs(metadata, options),
    ],
    composerAttachments: structuredInput?.composerAttachments ?? [],
  });
}

/**
 * `text` is the composed admission input. The sanitizer above parses metadata independently
 * of the message it accompanies, so the half of the token contract that needs the text — the
 * message still contains the token — can only be enforced where both are in hand. Pass it at
 * the request boundary; a reference whose token the submitted text no longer carries is
 * rejected there, and its siblings are admitted (INV-4).
 */
export function sanitizeSessionStructuredInputMeta(
  value: MetadataRecord,
  options: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string>; text?: string }> = {},
): MetadataRecord {
  const meta: MetadataRecord = { ...value };
  const structuredInput = readHappierStructuredInputV1FromMeta(meta, options);
  if (structuredInput) {
    meta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1] = typeof options.text === 'string'
      ? admitStructuredInputMentionsForText(structuredInput, options.text)
      : structuredInput;
  } else if (Object.prototype.hasOwnProperty.call(meta, HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1)) {
    delete meta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1];
  }
  delete meta[HAPPIER_VENDOR_PLUGIN_MENTIONS_METADATA_KEY];
  delete meta[HAPPIER_SKILL_MENTIONS_METADATA_KEY];
  return meta;
}

export function admitStructuredInputMentionsForText(
  envelope: HappierStructuredInputV1,
  text: string,
): HappierStructuredInputV1 {
  const mentions = envelope.mentions ?? [];
  if (mentions.length === 0) return envelope;
  const admitted = admitMentionRefsV1ForText(text, mentions);
  if (admitted.length === mentions.length) return envelope;
  const next: MetadataRecord = { ...envelope };
  if (admitted.length > 0) {
    next.mentions = admitted;
  } else {
    delete next.mentions;
  }
  return HappierStructuredInputV1Schema.parse(next);
}

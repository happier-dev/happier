import { z } from 'zod';

import {
  SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND,
  StructuredImageInputV1Schema,
  type StructuredImageInputV1,
} from './imageInputV1.js';
import { SkillMentionOriginV1Schema, SkillMentionV1Schema, type SkillMentionV1 } from './skillMentionV1.js';
import { VendorPluginMentionV1Schema, type VendorPluginMentionV1 } from './vendorPluginMentionV1.js';

export const HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 = 'happierStructuredInputV1';
export const HAPPIER_VENDOR_PLUGIN_MENTIONS_METADATA_KEY = 'happierVendorPluginMentions';
export const HAPPIER_SKILL_MENTIONS_METADATA_KEY = 'happierSkillMentions';

type MetadataRecord = Record<string, unknown>;

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
  return VendorPluginMentionV1Schema.parse(candidate);
}

function normalizeSkillMentionOrigin(value: unknown): 'vendor' | 'happier' | null {
  const origin = readString(value);
  if (!origin) return null;
  const direct = SkillMentionOriginV1Schema.safeParse(origin);
  if (direct.success) return direct.data;
  if (origin.endsWith('_native')) return 'vendor';
  if (origin === 'happier_projected' || origin === 'text_fallback_only') return 'happier';
  return null;
}

function normalizeSkillMention(value: MetadataRecord): SkillMentionV1 | null {
  const name = readString(value.name ?? value.displayName);
  if (!name) return null;

  const path = readString(value.path);
  const id = readString(value.id ?? value.projectionRef ?? path ?? name);
  const origin = normalizeSkillMentionOrigin(value.origin);
  const label = readString(value.label ?? value.displayName);
  const candidate = {
    ...value,
    ...(id ? { id } : {}),
    name,
    ...(origin ? { origin } : {}),
    ...(path ? { path } : {}),
    ...(label ? { label } : {}),
    ...(readString(value.projectionRef) ? { projectionRef: readString(value.projectionRef) } : {}),
    ...(readString(value.backendId) ? { backendId: readString(value.backendId) } : {}),
    ...(readString(value.agentId) ? { agentId: readString(value.agentId) } : {}),
  };
  return SkillMentionV1Schema.parse(candidate);
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
    return StructuredImageInputV1Schema.parse({
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
  return StructuredImageInputV1Schema.parse({
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

export const HappierStructuredInputV1Schema = z.object({
  v: z.literal(1).default(1),
  vendorPluginMentions: z.array(VendorPluginMentionV1Schema).optional(),
  skillMentions: z.array(SkillMentionV1Schema).optional(),
  imageInputs: z.array(StructuredImageInputV1Schema).optional(),
}).passthrough();

export type HappierStructuredInputV1 = z.infer<typeof HappierStructuredInputV1Schema>;

function buildStructuredInputEnvelope(params: Readonly<{
  base?: MetadataRecord | null;
  vendorPluginMentions: readonly VendorPluginMentionV1[];
  skillMentions: readonly SkillMentionV1[];
  imageInputs: readonly StructuredImageInputV1[];
}>): HappierStructuredInputV1 | null {
  if (
    !params.base
    && params.vendorPluginMentions.length === 0
    && params.skillMentions.length === 0
    && params.imageInputs.length === 0
  ) {
    return null;
  }

  const envelope: MetadataRecord = {
    ...(params.base ?? {}),
    v: 1,
  };
  delete envelope.attachments;

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
  return buildStructuredInputEnvelope({
    base: structuredInput,
    vendorPluginMentions: [
      ...(structuredInput?.vendorPluginMentions ?? []),
      ...normalizeVendorPluginMentions(metadata[HAPPIER_VENDOR_PLUGIN_MENTIONS_METADATA_KEY]),
    ],
    skillMentions: [
      ...(structuredInput?.skillMentions ?? []),
      ...normalizeSkillMentions(metadata[HAPPIER_SKILL_MENTIONS_METADATA_KEY]),
    ],
    imageInputs: [
      ...(structuredInput?.imageInputs ?? []),
      ...normalizeAttachmentEnvelopeImageInputs(metadata, options),
    ],
  });
}

export function sanitizeSessionStructuredInputMeta(
  value: MetadataRecord,
  options: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string> }> = {},
): MetadataRecord {
  const meta: MetadataRecord = { ...value };
  const structuredInput = readHappierStructuredInputV1FromMeta(meta, options);
  if (structuredInput) {
    meta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1] = structuredInput;
  } else if (Object.prototype.hasOwnProperty.call(meta, HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1)) {
    delete meta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1];
  }
  delete meta[HAPPIER_VENDOR_PLUGIN_MENTIONS_METADATA_KEY];
  delete meta[HAPPIER_SKILL_MENTIONS_METADATA_KEY];
  return meta;
}

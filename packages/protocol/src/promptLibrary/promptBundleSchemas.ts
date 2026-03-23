import { z } from 'zod';
import { decodeBase64 } from '../crypto/base64.js';

const PromptBundleSchemaIdV1Schema = z.enum(['skills.skill_md_v1', 'bundle.generic_v1']);
export type PromptBundleSchemaIdV1 = z.infer<typeof PromptBundleSchemaIdV1Schema>;
export { PromptBundleSchemaIdV1Schema };

export const PromptBundleEntryV1Schema = z
  .object({
    path: z.string().min(1),
    contentBase64: z.string().min(1),
    contentKind: z.enum(['utf8', 'binary']),
    unixMode: z.number().int().min(0).max(0o7777).nullable().optional(),
  })
  .strict();

export type PromptBundleEntryV1 = z.infer<typeof PromptBundleEntryV1Schema>;

export const PromptBundleBodyV1Schema = z
  .object({
    v: z.literal(1),
    entries: z.array(PromptBundleEntryV1Schema),
    createdAtMs: z.number().int().min(0),
    updatedAtMs: z.number().int().min(0),
  })
  .strict();

export type PromptBundleBodyV1 = z.infer<typeof PromptBundleBodyV1Schema>;

export const PROMPT_BUNDLE_SCHEMA_LIMITS_V1 = Object.freeze({
  maxEntries: 128,
  maxTotalBytes: 1024 * 1024,
});

export type PromptBundleValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      errorCode: 'unsupported_schema' | 'missing_required_entry' | 'invalid_request' | 'invalid_path' | 'duplicate_path' | 'size_limit_exceeded';
      message: string;
      path?: string;
      requiredPath?: string;
    }>;

function normalizePosixRelativePath(raw: string): { ok: true; normalized: string } | { ok: false; message: string } {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, message: 'path is empty' };
  if (value.startsWith('/')) return { ok: false, message: 'path must be relative' };
  if (value.includes('\\')) return { ok: false, message: 'path must use posix separators' };
  if (value.includes('\u0000')) return { ok: false, message: 'path contains null byte' };

  const segments = value.split('/');
  if (segments.some((s) => s.length === 0)) return { ok: false, message: 'path contains empty segment' };
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return { ok: false, message: 'path contains dot segment' };
  }

  return { ok: true, normalized: segments.join('/') };
}

export function validatePromptBundleBodyV1AgainstSchemaId(input: Readonly<{
  bundleSchemaId: PromptBundleSchemaIdV1;
  body: PromptBundleBodyV1;
}>): PromptBundleValidationResult {
  const schemaId = input.bundleSchemaId;
  const body = input.body;

  const bodyParsed = PromptBundleBodyV1Schema.safeParse(body);
  if (!bodyParsed.success) {
    return { ok: false, errorCode: 'invalid_request', message: 'invalid_body' };
  }

  if (body.entries.length > PROMPT_BUNDLE_SCHEMA_LIMITS_V1.maxEntries) {
    return {
      ok: false,
      errorCode: 'size_limit_exceeded',
      message: `bundle exceeds max entry count of ${PROMPT_BUNDLE_SCHEMA_LIMITS_V1.maxEntries}`,
    };
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of body.entries) {
    const normalized = normalizePosixRelativePath(entry.path);
    if (!normalized.ok) {
      return {
        ok: false,
        errorCode: 'invalid_path',
        message: normalized.message,
        path: entry.path,
      };
    }
    if (seen.has(normalized.normalized)) {
      return {
        ok: false,
        errorCode: 'duplicate_path',
        message: 'duplicate entry path',
        path: normalized.normalized,
      };
    }
    seen.add(normalized.normalized);

    totalBytes += decodeBase64(entry.contentBase64, 'base64').byteLength;
    if (totalBytes > PROMPT_BUNDLE_SCHEMA_LIMITS_V1.maxTotalBytes) {
      return {
        ok: false,
        errorCode: 'size_limit_exceeded',
        message: `bundle exceeds max total bytes of ${PROMPT_BUNDLE_SCHEMA_LIMITS_V1.maxTotalBytes}`,
        path: normalized.normalized,
      };
    }
  }

  if (schemaId === 'skills.skill_md_v1') {
    if (!seen.has('SKILL.md')) {
      return {
        ok: false,
        errorCode: 'missing_required_entry',
        message: 'skills bundles require SKILL.md at bundle root',
        requiredPath: 'SKILL.md',
      };
    }
  } else if (schemaId !== 'bundle.generic_v1') {
    return { ok: false, errorCode: 'unsupported_schema', message: `unsupported schema: ${schemaId}` };
  }

  return { ok: true };
}

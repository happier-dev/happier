import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { encodeBase64, readCanonicalPaddedBase64DecodedLength } from '../crypto/base64.js';
import { UsageQuerySchema, normalizeUsageQuery } from '../inputs/usageQuery.js';
import { UsageAnalyticsQueryResponseSchema, UsageQueryAccountingSchema } from './usageAnalyticsContracts.js';

export const UsageExportFieldSchema = lazyZodSchema(() => z.keyof(z.omit(UsageAnalyticsQueryResponseSchema,
  { v: true, summary: true, sessionIds: true, sessionMembership: true })));
export const UsageExportInputSchema = lazyZodSchema(() => z.strictObject({
  query: UsageQuerySchema, format: z.enum(['json', 'csv', 'text']), fields: z.array(UsageExportFieldSchema).check(z.minLength(1)),
}));
export type UsageExportInput = z.infer<typeof UsageExportInputSchema>;
export const USAGE_EXPORT_FORMATS = {
  json: { mediaType: 'application/json', extension: 'json' },
  csv: { mediaType: 'text/csv', extension: 'csv' },
  text: { mediaType: 'text/plain', extension: 'txt' },
} as const;

/** File bytes only: no path, upload destination, clipboard effect or public URL. */
export const UsageFileResultSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), mediaType: z.string().check(z.trim(), z.minLength(1)),
  fileName: z.string().check(z.minLength(1), z.refine(name => name !== '.' && name !== '..' && !/[\\/\u0000-\u001f\u007f]/.test(name), 'Unsafe display name')),
  base64: z.string().check(z.refine(value => readCanonicalPaddedBase64DecodedLength(value) !== null, 'Invalid base64')),
  fields: z.array(z.union([UsageExportFieldSchema, z.enum(['resets', 'renewals'])])).check(z.minLength(1)), asOfMs: z.nullable(z.number().check(z.int(), z.minimum(0))),
}));
export type UsageFileResult = z.infer<typeof UsageFileResultSchema>;

export function formatUsageExportFileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** Shared file-result encoding for already-authorized usage document serializers. */
export function buildUsageTextFileResult(input: Readonly<Omit<UsageFileResult, 'v' | 'base64'> & { content: string }>): UsageFileResult {
  const { content, ...metadata } = input;
  return UsageFileResultSchema.parse({ v: 1, ...metadata, base64: encodeBase64(new TextEncoder().encode(content)) });
}

/** RFC 4180 quoting, shared by personal and Team usage export delivery. */
export function escapeUsageCsvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildUsageCsvDocument(rows: readonly (readonly string[])[]): string {
  return `${rows.map(row => row.map(escapeUsageCsvField).join(',')).join('\n')}\n`;
}

/** Serialize only explicitly selected authorized facts, identically on headless and UI hosts. */
export function buildUsageFileResult(input: UsageExportInput, value: z.infer<typeof UsageQueryAccountingSchema>, asOfMs: number | null): UsageFileResult {
  const request = UsageExportInputSchema.parse(input);
  const accounting = UsageQueryAccountingSchema.parse(value);
  const fields = [...new Set(request.fields)];
  const selected = Object.fromEntries(fields.map(field => [field, accounting[field]]));
  let content: string;
  if (request.format === 'json') {
    content = JSON.stringify({ v: 1, query: normalizeUsageQuery(request.query), fields, asOfMs, accounting: selected }, null, 2);
  } else if (request.format === 'csv') {
    const rows: string[][] = [['costBasis', 'field', 'index', 'value']];
    for (const field of fields) {
      const section = accounting[field];
      const values = Array.isArray(section) ? section : [section];
      values.forEach((item, index) => rows.push([request.query.costBasis, field, String(index), item === undefined ? '' : JSON.stringify(item)]));
    }
    content = buildUsageCsvDocument(rows);
  } else {
    content = `costBasis: ${request.query.costBasis}\n` + fields.map(field => `${field}: ${accounting[field] === undefined ? 'unavailable' : JSON.stringify(accounting[field])}`).join('\n') + '\n';
  }
  const { extension, mediaType } = USAGE_EXPORT_FORMATS[request.format];
  return buildUsageTextFileResult({
    mediaType,
    fileName: asOfMs === null ? `usage.${extension}` : `usage-${asOfMs}.${extension}`,
    content, fields, asOfMs });
}

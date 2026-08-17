import { z } from 'zod';

import { SessionSystemRecordKindSchema } from './sessionSystemRecordKind.js';
import { SessionSystemRecordNamespaceSchema } from './sessionSystemRecordNamespace.js';

const FORBIDDEN_LOCAL_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const textEncoder = new TextEncoder();

function boundedUtf8(maxBytes: number) {
  return z.string().refine((value) => textEncoder.encode(value).byteLength <= maxBytes, {
    message: `Value must not exceed ${maxBytes} UTF-8 bytes`,
  });
}

export const SessionSystemRecordNamespaceLocalIdSchema = boundedUtf8(64)
  .refine((value) => value === value.trim(), 'Value must already be trimmed')
  .refine((value) => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value), 'Invalid local namespace')
  .refine((value) => !FORBIDDEN_LOCAL_IDS.has(value), 'Reserved local namespace');

export const SessionSystemRecordKindLocalIdSchema = SessionSystemRecordNamespaceLocalIdSchema;

export const SessionSystemRecordLocalIdSchema = boundedUtf8(256)
  .min(1)
  .refine((value) => value === value.trim(), 'Value must already be trimmed')
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are forbidden');

export const SessionSystemRecordAddressSchema = z.discriminatedUnion('owner', [
  z.object({
    owner: z.literal('plugin'),
    namespace: SessionSystemRecordNamespaceLocalIdSchema,
    kind: SessionSystemRecordKindLocalIdSchema,
    localId: SessionSystemRecordLocalIdSchema,
  }).strict(),
  z.object({
    owner: z.literal('host'),
    namespace: SessionSystemRecordNamespaceSchema,
    kind: SessionSystemRecordKindSchema,
    localId: SessionSystemRecordLocalIdSchema,
  }).strict(),
]);

export type SessionSystemRecordNamespaceLocalId = z.infer<typeof SessionSystemRecordNamespaceLocalIdSchema>;
export type SessionSystemRecordKindLocalId = z.infer<typeof SessionSystemRecordKindLocalIdSchema>;
export type SessionSystemRecordLocalId = z.infer<typeof SessionSystemRecordLocalIdSchema>;
export type SessionSystemRecordAddress = z.infer<typeof SessionSystemRecordAddressSchema>;

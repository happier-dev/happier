import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

const forbiddenCredentialKeys = new Set(['__proto__', 'constructor', 'prototype']);

export function isForbiddenQualifiedConnectedAccountCredentialKey(value: string): boolean {
  return forbiddenCredentialKeys.has(value);
}

export const QualifiedConnectedAccountCredentialKeyV1Schema = lazyZodSchema(() => z.string().check(
  z.minLength(1), z.maxLength(128), z.refine(value => !isForbiddenQualifiedConnectedAccountCredentialKey(value)),
));

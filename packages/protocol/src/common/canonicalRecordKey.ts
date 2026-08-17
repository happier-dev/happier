import { z } from 'zod';

export function canonicalBoundedStringSchema(max: number) {
  return z.string().min(1).max(max)
    .refine(
      (value) => value === value.trim(),
      'Identifier must already be canonical without surrounding whitespace',
    )
    .refine(
      (value) => !/[\u0000-\u001f\u007f]/u.test(value),
      'Identifier must not contain control characters',
    );
}

export function canonicalBoundedRecordKeySchema(max: number) {
  return canonicalBoundedStringSchema(max)
    .refine(
      (value) => !['__proto__', 'prototype', 'constructor'].includes(value),
      'Identifier is reserved and cannot be used as a record key',
    );
}

import { z } from 'zod';
import { ClientCompatibilityDeclarationV1Schema, type ClientCompatibilityDeclarationV1 } from './clientDeclarationV1.js';
import type { ClientCompatibilityDeclarationParseResult } from './httpHeadersV1.js';

export const ClientCompatibilitySocketAuthV1Schema = z.object({
  clientCompatibility: ClientCompatibilityDeclarationV1Schema,
}).passthrough();

export type ClientCompatibilitySocketAuthV1 = Readonly<{
  clientCompatibility: ClientCompatibilityDeclarationV1;
}>;

export function buildClientCompatibilitySocketAuthV1(input: ClientCompatibilityDeclarationV1): ClientCompatibilitySocketAuthV1 {
  return { clientCompatibility: ClientCompatibilityDeclarationV1Schema.parse(input) };
}

export function parseClientCompatibilitySocketAuthV1(
  input: unknown,
): ClientCompatibilityDeclarationParseResult {
  if (typeof input !== 'object' || input === null || !Object.prototype.hasOwnProperty.call(input, 'clientCompatibility')) {
    return { status: 'missing' };
  }
  const parsed = ClientCompatibilitySocketAuthV1Schema.safeParse(input);
  return parsed.success
    ? { status: 'valid', declaration: parsed.data.clientCompatibility }
    : { status: 'malformed' };
}

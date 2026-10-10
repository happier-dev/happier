import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_ID_CODE_UNITS = 128;
export const AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_REVISION = 2_147_483_647;

function isUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) return false;
  }
  return true;
}

export const AgentSessionStartupInstructionsIdV1Schema = lazyZodSchema(() => z.string()
  .min(1)
  .max(AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_ID_CODE_UNITS)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u));

export const AgentSessionStartupInstructionsTextV1Schema = lazyZodSchema(() => z.string()
  .refine((value) => value.trim().length > 0, 'Instructions must be nonempty')
  .refine(isUnicodeScalarString, 'Instructions must contain valid Unicode')
  .refine(
    (value) => value.normalize('NFC') === value,
    'Instructions must be NFC-normalized',
  ));

const AgentSessionStartupInstructionsMarkerV1Shape = {
  v: z.literal(1),
  id: AgentSessionStartupInstructionsIdV1Schema,
  revision: z.number()
    .int()
    .positive()
    .max(AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_REVISION),
} as const;

export const AgentSessionStartupInstructionsMarkerV1Schema = lazyZodSchema(() => z.object(
  AgentSessionStartupInstructionsMarkerV1Shape,
).strict().readonly());

export type AgentSessionStartupInstructionsMarkerV1 = z.infer<
  typeof AgentSessionStartupInstructionsMarkerV1Schema
>;

export const AgentSessionStartupInstructionsV1Schema = lazyZodSchema(() => z.object({
  ...AgentSessionStartupInstructionsMarkerV1Shape,
  instructions: AgentSessionStartupInstructionsTextV1Schema,
}).strict().readonly());

export type AgentSessionStartupInstructionsV1 = z.infer<
  typeof AgentSessionStartupInstructionsV1Schema
>;

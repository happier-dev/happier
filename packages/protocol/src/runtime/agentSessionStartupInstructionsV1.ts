import { maxCodeUnits } from '../strings/maxCodeUnits.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

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

export const AgentSessionStartupInstructionsIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), maxCodeUnits(AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_ID_CODE_UNITS), z.regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u)));

export const AgentSessionStartupInstructionsTextV1Schema = lazyZodSchema(() => z.string().check(z.refine((value) => value.trim().length > 0, 'Instructions must be nonempty'), z.refine(isUnicodeScalarString, 'Instructions must contain valid Unicode'), z.refine((value) => value.normalize('NFC') === value, 'Instructions must be NFC-normalized')));

const AgentSessionStartupInstructionsMarkerV1Shape = {
  v: z.literal(1),
  id: AgentSessionStartupInstructionsIdV1Schema,
  revision: z.number().check(z.int(), z.positive(), z.maximum(AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_REVISION)),
} as const;

export const AgentSessionStartupInstructionsMarkerV1Schema = lazyZodSchema(() => z.readonly(z.strictObject(AgentSessionStartupInstructionsMarkerV1Shape)));

export type AgentSessionStartupInstructionsMarkerV1 = z.infer<
  typeof AgentSessionStartupInstructionsMarkerV1Schema
>;

export const AgentSessionStartupInstructionsV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  ...AgentSessionStartupInstructionsMarkerV1Shape,
  instructions: AgentSessionStartupInstructionsTextV1Schema,
})));

export type AgentSessionStartupInstructionsV1 = z.infer<
  typeof AgentSessionStartupInstructionsV1Schema
>;

import { z } from 'zod';

/**
 * Measured r1.5.2 global Voice plan: 1,104 UTF-8 bytes; complete V1 carrier:
 * 1,194 UTF-8 bytes (90 bytes of carrier overhead). A 2 KiB instruction ceiling
 * leaves 944 bytes of text growth plus native `developerInstructions`
 * field overhead.
 */
export const AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_UTF8_BYTES = 2_048;
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

export const AgentSessionStartupInstructionsIdV1Schema = z.string()
  .min(1)
  .max(AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_ID_CODE_UNITS)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);

export const AgentSessionStartupInstructionsTextV1Schema = z.string()
  .refine((value) => value.trim().length > 0, 'Instructions must be nonempty')
  .refine(isUnicodeScalarString, 'Instructions must contain valid Unicode')
  .refine(
    (value) => value.normalize('NFC') === value,
    'Instructions must be NFC-normalized',
  )
  .refine(
    (value) => (
      new TextEncoder().encode(value).byteLength
      <= AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_UTF8_BYTES
    ),
    'Instructions exceed the UTF-8 byte limit',
  );

const AgentSessionStartupInstructionsMarkerV1Shape = {
  v: z.literal(1),
  id: AgentSessionStartupInstructionsIdV1Schema,
  revision: z.number()
    .int()
    .positive()
    .max(AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_REVISION),
} as const;

export const AgentSessionStartupInstructionsMarkerV1Schema = z.object(
  AgentSessionStartupInstructionsMarkerV1Shape,
).strict().readonly();

export type AgentSessionStartupInstructionsMarkerV1 = z.infer<
  typeof AgentSessionStartupInstructionsMarkerV1Schema
>;

export const AgentSessionStartupInstructionsV1Schema = z.object({
  ...AgentSessionStartupInstructionsMarkerV1Shape,
  instructions: AgentSessionStartupInstructionsTextV1Schema,
}).strict().readonly();

export type AgentSessionStartupInstructionsV1 = z.infer<
  typeof AgentSessionStartupInstructionsV1Schema
>;

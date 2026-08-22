import { z } from 'zod';

/**
 * Any installed Agent id, as it travels on a V1 wire.
 *
 * Agent identity is open: plugin manifests admit a local Agent identifier, so
 * an externally installed Agent — and every bundled Agent outside a narrower
 * generated subset — legitimately carries an id that no static protocol enum
 * lists. Bounded parsing (non-blank, already trimmed, length capped) is the
 * whole wire contract here.
 *
 * Deciding whether the host bundles *facts* for an id is a separate question
 * owned by the bundled-fact readers in `@happier-dev/agents`
 * (`isBundledAgentId` / `readBundledAgentFact`), which report "no bundled
 * fact" rather than "unsupported Agent". A closed enum at this boundary would
 * silently drop Agents instead, so this schema must stay open.
 */
export const AgentIdV1Schema = z.string()
  .min(1)
  .max(128)
  .refine(
    (value) => value === value.trim(),
    'Agent id must already be trimmed.',
  );
export type AgentIdV1 = z.infer<typeof AgentIdV1Schema>;

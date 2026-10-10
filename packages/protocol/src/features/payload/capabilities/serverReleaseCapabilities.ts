import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

/**
 * The running server binary: its release version and flavour (plan `2026-09-26-home-owner-console`
 * §3.7). Diagnostic only, never a gate.
 *
 * A top-level family of its own, like `serverIdentity`, rather than fields of the strict
 * `capabilities.server` object: every released reader (0.2.11 CLI/UI, tag `cli-v0.2.11`,
 * commit 98ea8fb767) and every earlier 0.3 build parses `capabilities.server` strictly and would
 * refuse the whole features payload, while the capabilities root drops a family it does not know.
 */
export const ServerReleaseCapabilitiesSchema = lazyZodSchema(() => z.object({
  version: z.string().trim().min(1).optional(),
  flavor: z.enum(['full', 'light']).optional(),
}).strict());

export type ServerReleaseCapabilities = z.infer<typeof ServerReleaseCapabilitiesSchema>;

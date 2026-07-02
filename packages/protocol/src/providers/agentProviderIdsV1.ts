/**
 * GENERATED FILE CONTRACT (A.X-agent-ids-codegen)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 *
 * This protocol-owned V1 wire schema intentionally preserves the existing
 * daemon-facing provider id subset while deriving it from the generated
 * bundled agent id source. Protocol cannot import `@happier-dev/agents`
 * because that would create a package dependency cycle.
 */

import { z } from 'zod';

export const AGENT_PROVIDER_IDS_V1 = Object.freeze([
  'claude',
  'codex',
  'opencode',
  'pi',
  'ohMyPi',
] as const);

export type AgentProviderIdV1 = (typeof AGENT_PROVIDER_IDS_V1)[number];

export const AgentProviderIdV1Schema = z.enum(AGENT_PROVIDER_IDS_V1);

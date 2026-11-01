import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

// Intentionally scoped: this is the subset of providers that participate in v1 daemon-facing
// provider ids (direct sessions, handoff resume plans, MCP detection).
//
// ACP-listing providers participate only through the generic `acpSessionList` direct-sessions source.
// Membership here is transport admission, not a capability claim: the authoritative declaration is
// `isAcpSessionListingDeclared` in `@happier-dev/agents`, the daemon re-checks it in
// `validateDirectMachineSource`, and the live ACP handshake remains the runtime authority.
export const AGENT_PROVIDER_IDS_V1 = [
  'claude',
  'codex',
  'opencode',
  'pi',
  'auggie',
  'qwen',
  'kimi',
  'kilo',
  'devin',
  'copilot',
  'fx',
] as const;

export type AgentProviderIdV1 = (typeof AGENT_PROVIDER_IDS_V1)[number];

export const AgentProviderIdV1Schema = lazySchema(() => z.enum(AGENT_PROVIDER_IDS_V1));

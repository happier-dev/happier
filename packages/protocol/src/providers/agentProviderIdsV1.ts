import { z } from 'zod';

// Intentionally scoped: this is the subset of providers that participate in v1 daemon-facing
// provider ids (direct sessions, handoff resume plans, MCP detection).
export const AGENT_PROVIDER_IDS_V1 = ['claude', 'codex', 'opencode'] as const;

export type AgentProviderIdV1 = (typeof AGENT_PROVIDER_IDS_V1)[number];

export const AgentProviderIdV1Schema = z.enum(AGENT_PROVIDER_IDS_V1);

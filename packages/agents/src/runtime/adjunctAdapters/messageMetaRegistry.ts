import type { AgentId } from '../../types.js';
import type { ProviderMessageMetaEnricher, ProviderMessageMetaRegistration } from './types.js';

const EMPTY_PROVIDER_MESSAGE_META_ENRICHER: ProviderMessageMetaEnricher = {};
const PROVIDER_MESSAGE_META_ENRICHERS = new Map<AgentId, ProviderMessageMetaEnricher>();

export function registerProviderMessageMetaEnricher(registration: ProviderMessageMetaRegistration): void {
  PROVIDER_MESSAGE_META_ENRICHERS.set(registration.agentId, registration.enricher);
}

export function getProviderMessageMetaEnricher(agentId: AgentId): ProviderMessageMetaEnricher {
  return PROVIDER_MESSAGE_META_ENRICHERS.get(agentId) ?? EMPTY_PROVIDER_MESSAGE_META_ENRICHER;
}

export function resolveProviderOutgoingMessageMetaExtras(params: Readonly<{
  agentId: AgentId | null;
  settings: Readonly<Record<string, unknown>>;
  session: unknown;
}>): Readonly<Record<string, unknown>> {
  void params.session;
  return params.agentId ? getProviderMessageMetaEnricher(params.agentId).buildOutgoingMessageMetaExtras?.(params.settings) ?? {} : {};
}

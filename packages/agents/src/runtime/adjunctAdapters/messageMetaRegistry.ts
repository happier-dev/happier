import type { AgentId } from '../../types.js';
import type { ProviderMessageMetaEnricher } from './types.js';
import { buildClaudeRemoteOutgoingMessageMetaExtras } from '../messageMeta/claudeRemote.js';

const EMPTY_PROVIDER_MESSAGE_META_ENRICHER: ProviderMessageMetaEnricher = {};

export function getProviderMessageMetaEnricher(agentId: AgentId): ProviderMessageMetaEnricher {
  switch (agentId) {
    case 'claude':
      return {
        buildOutgoingMessageMetaExtras: buildClaudeRemoteOutgoingMessageMetaExtras,
      };
    default:
      return EMPTY_PROVIDER_MESSAGE_META_ENRICHER;
  }
}

export function resolveProviderOutgoingMessageMetaExtras(params: Readonly<{
  agentId: AgentId | null;
  settings: Readonly<Record<string, unknown>>;
  session: unknown;
}>): Readonly<Record<string, unknown>> {
  void params.session;
  return params.agentId ? getProviderMessageMetaEnricher(params.agentId).buildOutgoingMessageMetaExtras?.(params.settings) ?? {} : {};
}

export { buildClaudeRemoteOutgoingMessageMetaExtras } from '../messageMeta/claudeRemote.js';

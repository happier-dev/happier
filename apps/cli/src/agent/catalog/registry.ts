import type {
  AgentCatalogEntry,
  CatalogAgentLookupId,
} from './types';
import { readAgentCatalogSnapshot } from './snapshot';

export function readCatalogEntriesSnapshot(): Record<string, AgentCatalogEntry> {
  const projectedEntries = readAgentCatalogSnapshot().catalogEntriesById as Record<string, AgentCatalogEntry>;
  return { ...projectedEntries };
}

const AGENT_PROXY_TARGET: Record<string, AgentCatalogEntry> = Object.create(null);

export const AGENTS: Record<string, AgentCatalogEntry> = new Proxy(AGENT_PROXY_TARGET, {
  get(_target, property) {
    if (typeof property !== 'string') {
      return Reflect.get(_target, property);
    }
    return readCatalogEntriesSnapshot()[property];
  },
  has(_target, property) {
    if (typeof property !== 'string') {
      return Reflect.has(_target, property);
    }
    return Object.prototype.hasOwnProperty.call(readCatalogEntriesSnapshot(), property);
  },
  ownKeys() {
    return Reflect.ownKeys(readCatalogEntriesSnapshot());
  },
  getOwnPropertyDescriptor(_target, property) {
    if (typeof property !== 'string') {
      return Reflect.getOwnPropertyDescriptor(_target, property);
    }
    const value = readCatalogEntriesSnapshot()[property];
    if (!value) {
      return undefined;
    }
    return {
      configurable: true,
      enumerable: true,
      writable: false,
      value,
    };
  },
});

export function requireCatalogEntry(agentId: CatalogAgentLookupId): AgentCatalogEntry {
  const entry = AGENTS[agentId];
  if (!entry) throw new Error(`Missing catalog agent entry for ${agentId}`);
  return entry;
}

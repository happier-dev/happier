import type {
  AgentCatalogEntry,
  CatalogAgentLookupId,
} from './types';
import type { ConnectedServiceId } from '@happier-dev/protocol';
import { readAgentCatalogSnapshot } from './snapshot';

/**
 * The one catalog lookup failure contract. A caller must never substitute a
 * bundled Agent when its requested installed Agent is absent.
 */
export class CatalogAgentNotInstalledError extends Error {
  readonly code = 'agent_not_installed' as const;
  readonly agentId: string;

  constructor(agentId: string) {
    super(`Agent '${agentId}' is not installed or unavailable in the current Agent catalog`);
    this.name = 'CatalogAgentNotInstalledError';
    this.agentId = agentId;
  }
}

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

const NO_DECLARED_CONNECTED_SERVICE_IDS: readonly ConnectedServiceId[] = Object.freeze([]);

/**
 * Reads the current catalog entry without treating a missing external Agent as a
 * built-in fallback. Callers that hold a registry lease should instead inspect
 * that lease's entry directly.
 */
export function findCatalogEntry(agentId: string): AgentCatalogEntry | null {
  return AGENTS[agentId] ?? null;
}

/**
 * The executable Agent catalog is the sole owner of legacy Connected Service
 * compatibility declarations. An absent entry has no declared services.
 */
export function readDeclaredCatalogConnectedServiceIds(
  entry: Pick<AgentCatalogEntry, 'connectedServiceIds'> | null | undefined,
): readonly ConnectedServiceId[] {
  return entry?.connectedServiceIds ?? NO_DECLARED_CONNECTED_SERVICE_IDS;
}

export function resolveCatalogAgentConnectedServiceIds(
  agentId: string,
): readonly ConnectedServiceId[] {
  return readDeclaredCatalogConnectedServiceIds(findCatalogEntry(agentId));
}

export function requireCatalogEntry(agentId: CatalogAgentLookupId): AgentCatalogEntry {
  const entry = findCatalogEntry(agentId);
  if (!entry) throw new CatalogAgentNotInstalledError(agentId);
  return entry;
}

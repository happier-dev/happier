import { beforeEach, describe, expect, it, vi } from 'vitest';

const registryMocks = vi.hoisted(() => ({
  getResolvedContributionRegistry: vi.fn(),
  getReloadState: vi.fn<() => { activeRegistry: object | null }>(() => ({ activeRegistry: null })),
  isRuntimeRegistryCurrent: vi.fn(() => true),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  getResolvedContributionRegistry: registryMocks.getResolvedContributionRegistry,
}));

vi.mock('@/plugins/runtime/reload/singleton', () => ({
  pluginReloadController: {
    getState: registryMocks.getReloadState,
    isRuntimeRegistryCurrent: registryMocks.isRuntimeRegistryCurrent,
  },
}));

import {
  resolveInactiveSessionCatalogControls,
  resolveInactiveSessionGoalControls,
  resolveInactiveSessionUsageLimitRecoveryControls,
} from './sessionControlAdapters';

const EXTERNAL_AGENT_CONTRIBUTES = {
  agentDefinitionsById: new Map([
    ['acme.agent', {
      id: 'acme.agent',
      identity: { pluginId: 'acme', localId: 'acme.agent' },
      richDefinition: {
        definition: {
          id: 'acme.agent',
          primary: true,
          capabilities: {
            sessions: {
              goals: { inactive: { get: true, set: { kind: 'text' }, clear: true } },
              catalog: { inactive: ['skills', 'vendorPlugins'] },
              usageLimitRecovery: { inactive: ['checkNow'] },
            },
          },
        },
      },
    }],
  ]),
  catalogEntriesById: {
    'acme.agent': { id: 'acme.agent', cliSubcommand: 'acme-agent' },
  },
};

describe('inactive session control adapters for an externally contributed Agent', () => {
  beforeEach(() => {
    // The cold module cache holds built-ins only until a prime runs, and never a
    // plugin reload that happened afterwards.
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {},
    });
    registryMocks.getReloadState.mockReturnValue({
      activeRegistry: { contributes: EXTERNAL_AGENT_CONTRIBUTES },
    });
    registryMocks.isRuntimeRegistryCurrent.mockReturnValue(true);
  });

  it('reads the declared capabilities of an Agent only the current runtime registry knows about', async () => {
    await expect(resolveInactiveSessionGoalControls('acme.agent')).resolves.not.toBeNull();
    await expect(resolveInactiveSessionCatalogControls('acme.agent')).resolves.not.toBeNull();
    await expect(
      resolveInactiveSessionUsageLimitRecoveryControls('acme.agent'),
    ).resolves.not.toBeNull();
  });

  it('still refuses an Agent that no registry generation declares', async () => {
    await expect(resolveInactiveSessionGoalControls('missing.agent')).resolves.toBeNull();
    await expect(resolveInactiveSessionCatalogControls('missing.agent')).resolves.toBeNull();
    await expect(
      resolveInactiveSessionUsageLimitRecoveryControls('missing.agent'),
    ).resolves.toBeNull();
  });
});

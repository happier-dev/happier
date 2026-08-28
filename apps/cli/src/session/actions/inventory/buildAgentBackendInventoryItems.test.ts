import { buildBackendTargetKeyV2 } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  readAgentCatalogSnapshot,
  listConfiguredAcpBackendsFromAccountSettings,
} = vi.hoisted(() => ({
  readAgentCatalogSnapshot: vi.fn(),
  listConfiguredAcpBackendsFromAccountSettings: vi.fn<() => Promise<readonly Readonly<{
    backendId: string;
    title: string;
    description?: string;
  }>[]>>(async () => []),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

vi.mock('@/agent/acp/catalog/configured/resolveBackend', () => ({
  listConfiguredAcpBackendsFromAccountSettings,
}));

import { buildAgentBackendInventoryItems } from './buildAgentBackendInventoryItems';

describe('buildAgentBackendInventoryItems', () => {
  beforeEach(() => {
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map([
        ['codex', {
          id: 'codex',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          richDefinition: { definition: { title: 'Codex' } },
          runtimeSpec: null,
        }],
        ['acme-agent', {
          id: 'acme-agent',
          identity: { pluginId: 'acme.plugin', localId: 'acme-agent' },
          richDefinition: { definition: { title: 'Acme Agent' } },
          runtimeSpec: null,
        }],
      ]),
      catalogEntriesById: {
        codex: {
          id: 'codex',
          cliSubcommand: 'codex',
          vendorResumeSupport: 'supported',
        },
        'acme-agent': {
          id: 'acme-agent',
          cliSubcommand: 'acme-agent',
          vendorResumeSupport: 'supported',
        },
      },
    });
    listConfiguredAcpBackendsFromAccountSettings.mockResolvedValue([]);
  });

  it('preserves the stable identity of an externally contributed catalog Agent', async () => {
    await expect(buildAgentBackendInventoryItems({ includeDisabled: true })).resolves.toContainEqual({
      targetKey: buildBackendTargetKeyV2({
        kind: 'backend',
        backendId: 'acme-agent',
        sourceKind: 'built_in',
      }),
      label: 'Acme Agent',
      enabled: true,
      agentId: 'acme-agent',
      identity: { pluginId: 'acme.plugin', localId: 'acme-agent' },
    });
  });

  it('preserves the stable identity of a bundled catalog Agent', async () => {
    await expect(buildAgentBackendInventoryItems({ includeDisabled: true })).resolves.toContainEqual({
      targetKey: buildBackendTargetKeyV2({
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      }),
      label: 'Codex',
      enabled: true,
      agentId: 'codex',
      identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
    });
  });

  it('keeps configured ACP backends selectable without manufacturing an Agent identity', async () => {
    listConfiguredAcpBackendsFromAccountSettings.mockResolvedValue([{
      backendId: 'review-bot',
      title: 'Review Bot',
      description: 'Configured ACP backend',
    }]);

    const items = await buildAgentBackendInventoryItems({ includeDisabled: true });

    expect(items).toContainEqual({
      targetKey: buildBackendTargetKeyV2({
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      }),
      label: 'Review Bot',
      description: 'Configured ACP backend',
      enabled: true,
      backendId: 'review-bot',
    });
    expect(items.find((item) => item.backendId === 'review-bot')).not.toHaveProperty('identity');
  });
});

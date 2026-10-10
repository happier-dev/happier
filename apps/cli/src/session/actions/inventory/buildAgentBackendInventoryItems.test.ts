import { buildBackendTargetKeyV2 } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

const {
  readAgentCatalogSnapshot,
} = vi.hoisted(() => ({
  readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

import { buildAgentBackendInventoryItems } from './buildAgentBackendInventoryItems';
const emptyCatalog = { status: 'ready', record: { v: 1, definitions: [] }, revision: 1 } satisfies AcpCatalogSnapshotV1;

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
        ['acme.plugin/acme-agent', {
          id: 'acme.plugin/acme-agent',
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
        'acme.plugin/acme-agent': {
          id: 'acme.plugin/acme-agent',
          cliSubcommand: 'acme-agent',
          vendorResumeSupport: 'supported',
        },
      },
    });
  });

  it('preserves the stable identity of an externally contributed catalog Agent', async () => {
    await expect(buildAgentBackendInventoryItems({ includeDisabled: true, acpCatalogSnapshot: emptyCatalog })).resolves.toContainEqual({
      targetKey: 'agent:acme.plugin/acme-agent',
      label: 'Acme Agent',
      enabled: true,
      agentId: 'acme.plugin/acme-agent',
      identity: { pluginId: 'acme.plugin', localId: 'acme-agent' },
    });
  });

  it('preserves the stable identity of a bundled catalog Agent', async () => {
    await expect(buildAgentBackendInventoryItems({ includeDisabled: true, acpCatalogSnapshot: emptyCatalog })).resolves.toContainEqual({
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
    const acpCatalogSnapshot = { status: 'ready', revision: 2, record: { v: 1, definitions: [{
      id: 'review-bot', name: 'review-bot', title: 'Review Bot', description: 'Configured ACP backend', command: 'review-bot',
      args: [], env: {}, capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown',
        supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' }, createdAt: 1, updatedAt: 1,
    }] } } satisfies AcpCatalogSnapshotV1;
    const items = await buildAgentBackendInventoryItems({ includeDisabled: true, acpCatalogSnapshot });

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

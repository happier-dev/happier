import { describe, expect, it, vi } from 'vitest';
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';

import type { PromptRegistryRegistry } from './createPromptRegistryAdapterRegistry';
import { installPromptRegistryItem, scanPromptRegistrySource } from './actions';

describe('prompt registry actions', () => {
  it('delegates source scans to the canonical registry owner', async () => {
    const scanSource = vi.fn(async () => []);
    const registry = { scanSource } as unknown as PromptRegistryRegistry;

    await expect(scanPromptRegistrySource({
      registry,
      request: { sourceId: 'external:catalog', configuredSources: [], query: 'review' },
    })).resolves.toEqual({ ok: true, items: [] });
    expect(scanSource).toHaveBeenCalledWith({
      sourceId: 'external:catalog',
      configuredSources: [],
      query: 'review',
    });
  });

  it('forwards caller cancellation through registry installation to the asset adapter', async () => {
    const signal = new AbortController().signal;
    const writeBundle = vi.fn(async () => ({ ok: true as const }));
    const adapter = {
      descriptor: {
        id: 'external.bundle',
        libraryKind: 'bundle',
        capabilities: { supportsCatalogInstall: true },
        supportsScope: { project: true, user: false },
      },
      writeBundle,
    } as unknown as PromptAssetAdapter;
    const registry = {
      fetchItem: vi.fn(async () => ({
        ok: true as const,
        item: {
          title: 'Reviewer',
          bundleSchemaId: 'skills.skill_md_v1' as const,
          bundleBody: { v: 1, entries: [], createdAtMs: 1, updatedAtMs: 1 },
        },
      })),
    } as unknown as PromptRegistryRegistry;

    await expect(installPromptRegistryItem({
      registry,
      assetRegistry: new Map([['external.bundle', adapter]]),
      request: {
        sourceId: 'external:catalog',
        itemId: 'reviewer',
        configuredSources: [],
        installTarget: {
          assetTypeId: 'external.bundle',
          scope: 'project',
          directory: '/workspace',
          targetName: 'reviewer',
        },
      },
      signal,
    })).resolves.toEqual({ ok: true });
    expect(writeBundle).toHaveBeenCalledWith(expect.objectContaining({
      assetTypeId: 'external.bundle',
      targetName: 'reviewer',
      title: 'Reviewer',
    }), { signal });
  });

  it('installs the already-fetched bundle without reading the registry a second time', async () => {
    const writeBundle = vi.fn(async () => ({ ok: true as const }));
    const adapter = {
      descriptor: {
        id: 'external.bundle',
        libraryKind: 'bundle',
        capabilities: { supportsCatalogInstall: true },
        supportsScope: { project: false, user: true },
      },
      writeBundle,
    } as unknown as PromptAssetAdapter;
    const fetchItem = vi.fn();
    const fetchedItem = {
      sourceId: 'source-1',
      itemId: 'item-1',
      title: 'Reviewer',
      bundleSchemaId: 'skills.skill_md_v1' as const,
      bundleBody: { v: 1 as const, entries: [], createdAtMs: 1, updatedAtMs: 1 },
    };

    await expect(installPromptRegistryItem({
      registry: { fetchItem } as unknown as PromptRegistryRegistry,
      assetRegistry: new Map([['external.bundle', adapter]]),
      fetchedItem,
      request: {
        sourceId: 'source-1',
        itemId: 'item-1',
        configuredSources: [],
        installTarget: {
          assetTypeId: 'external.bundle',
          scope: 'user',
          targetName: 'reviewer',
        },
      },
    })).resolves.toEqual({ ok: true });
    expect(fetchItem).not.toHaveBeenCalled();
    expect(writeBundle).toHaveBeenCalledOnce();
  });
});

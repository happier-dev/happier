import { describe, expect, it, vi } from 'vitest';
import { createPluginClientTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginClientActionContext } from '@happier-dev/plugin-sdk/actions';
import { DEVCONTAINER_PLUGIN } from '../manifest.js';
import { activate } from './runtimeInstall.js';

describe('Container runtime prerequisite repair', () => {
  it.each([
    ['docker', 'https://docs.docker.com/engine/install/'],
    ['podman', 'https://podman.io/docs/installation'],
  ])('opens the selected %s installation guide and preserves an opener failure', async (runtime, url) => {
    const kit = await createPluginClientTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest,
      target: { artifactId: 'runtime-install', exportName: 'activate', platform: 'web' }, activate });
    // The answering client's external-link host API is the effect boundary.
    const executeAction = vi.fn(async () => ({ status: 'opened' }));
    const signal = new AbortController().signal;
    const context = { signal, ui: { executeAction } } as unknown as PluginClientActionContext;
    try {
      const repair = kit.registration('actions', 'runtime-install-docs');
      expect(repair).toBeDefined();
      if (!repair) throw new Error('Missing runtime repair registration');
      await expect(repair({ runtime }, context)).resolves.toBeNull();
      expect(executeAction).toHaveBeenCalledWith('links.openExternal', { url }, { signal });
      const failure = new Error('external_link_unavailable');
      executeAction.mockRejectedValueOnce(failure);
      await expect(repair({ runtime }, context)).rejects.toBe(failure);
    } finally { await kit.dispose(); }
  });
});

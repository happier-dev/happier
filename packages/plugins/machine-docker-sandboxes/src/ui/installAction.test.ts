import { describe, expect, it, vi } from 'vitest';
import { createPluginClientTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginClientActionContext } from '@happier-dev/plugin-sdk/actions';
import { DOCKER_SANDBOXES_PLUGIN } from '../manifest.js';
import { activate, DOCKER_SANDBOXES_INSTALL_URL } from './installAction.js';

describe('Docker Sandboxes prerequisite repair', () => {
  it('opens installation instructions on the answering client and preserves an opener failure', async () => {
    const kit = await createPluginClientTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest,
      target: { artifactId: 'docker-sandboxes-machine-native', exportName: 'activate', platform: 'web' }, activate });
    const executeAction = vi.fn(async () => ({ status: 'opened' }));
    const signal = new AbortController().signal;
    // The client host API is the external effect boundary; activation and Action admission stay real.
    const context = { signal, invocationSurface: 'ui', ui: { executeAction } } as unknown as PluginClientActionContext;
    try {
      const repair = kit.registration('actions', 'install-docs');
      expect(repair).toBeDefined();
      if (!repair) throw new Error('Missing declared repair Action');
      await expect(repair({}, context)).resolves.toBeNull();
      expect(executeAction).toHaveBeenCalledExactlyOnceWith('links.openExternal', { url: DOCKER_SANDBOXES_INSTALL_URL }, { signal });
      executeAction.mockClear();
      for (const invocationSurface of ['agent', 'mcp', 'cli'] as const) {
        await expect(repair({}, { ...context, invocationSurface })).resolves.toEqual({ url: DOCKER_SANDBOXES_INSTALL_URL });
      }
      expect(executeAction).not.toHaveBeenCalled();
      const failure = new Error('external_link_unavailable');
      executeAction.mockRejectedValueOnce(failure);
      await expect(repair({}, context)).rejects.toBe(failure);
    } finally { await kit.dispose(); }
  });
});

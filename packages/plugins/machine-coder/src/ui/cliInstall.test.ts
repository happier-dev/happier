import { describe, expect, it } from 'vitest';
import { createPluginClientTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginClientActionContext } from '@happier-dev/plugin-sdk/actions';
import { PLUGIN } from '../manifest.js';
import { activate } from './cliInstall.js';

describe('Coder controller CLI prerequisite repair', () => {
  it('opens official installation guidance on the answering client and returns it for agent, MCP and CLI callers', async () => {
    const kit = await createPluginClientTestkit({ manifest: PLUGIN.manifest,
      target: { artifactId: 'cli-install', exportName: 'activate', platform: 'web' }, activate });
    const opened: unknown[] = [];
    let failure: Error | undefined;
    // The answering client's external-link host API is the effect boundary.
    const signal = new AbortController().signal;
    const context = { signal, invocationSurface: 'ui', ui: { executeAction: async (...args: unknown[]) => {
      if (failure) throw failure;
      opened.push(args); return { status: 'opened' };
    } } } as unknown as PluginClientActionContext;
    try {
      const repair = kit.registration('actions', 'cli-install-docs');
      if (!repair) throw new Error('Missing CLI installation repair');
      await expect(repair({}, context)).resolves.toBeNull();
      expect(opened).toEqual([['links.openExternal', { url: 'https://coder.com/docs/install/cli' }, { signal }]]);
      for (const invocationSurface of ['agent', 'mcp', 'cli'] as const) {
        await expect(repair({}, { ...context, invocationSurface })).resolves.toEqual({ url: 'https://coder.com/docs/install/cli' });
      }
      expect(opened).toHaveLength(1);
      failure = new Error('external_link_unavailable');
      await expect(repair({}, context)).rejects.toBe(failure);
    } finally { await kit.dispose(); }
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';

import { createCliActionDeps } from './createCliActionDeps';

describe('createCliActionDeps prompt library bindings', () => {
  it('binds all ordinary prompt-library ActionSpecs for authenticated production execution', () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });

    expect(deps.promptDocUpdate).toEqual(expect.any(Function));
    expect(deps.promptBundleUpdate).toEqual(expect.any(Function));
    expect(deps.promptAssetExport).toEqual(expect.any(Function));
    expect(deps.promptRegistryInstall).toEqual(expect.any(Function));
  });

  it('routes discover to the live registered adapter and preserves caller cancellation', async () => {
    const signal = new AbortController().signal;
    const discover = vi.fn(async () => [{
      assetTypeId: 'external.prompt',
      scope: 'user' as const,
      externalRef: { id: 'prompt-1' },
    }]);
    const adapter = {
      descriptor: { id: 'external.prompt' },
      discover,
    } as unknown as PromptAssetAdapter;
    const registered = new Map([['external.prompt', adapter]]);
    const deps = createCliActionDeps({
      token: 'token',
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
      readRegisteredPromptAssetAdapters: () => registered,
    });

    await expect(deps.daemonPromptAssetsDiscover?.({
      request: { assetTypeId: 'external.prompt', scope: 'user' },
      signal,
    })).resolves.toEqual({
      ok: true,
      items: [{
        assetTypeId: 'external.prompt',
        scope: 'user',
        externalRef: { id: 'prompt-1' },
      }],
    });
    expect(discover).toHaveBeenCalledWith(
      { assetTypeId: 'external.prompt', scope: 'user' },
      { signal },
    );
  });
});

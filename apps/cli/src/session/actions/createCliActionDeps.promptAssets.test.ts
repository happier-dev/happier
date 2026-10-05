import { describe, expect, it, vi } from 'vitest';
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';
import axios from 'axios';
import { accountSettingsParse, normalizeActionsSettingsV1 } from '@happier-dev/protocol';

import { createCliActionDeps } from './createCliActionDeps';

describe('createCliActionDeps prompt library bindings', () => {
  it('reads invocations from current Account settings and denies a session-only expansion before Artifact HTTP', async () => {
    const settings = accountSettingsParse({ promptInvocationsV1: { v: 1, entries: [{
      id: 'local', token: '/local', title: 'Local', availableIn: 'session_only', target: { kind: 'doc', artifactId: 'doc' },
    }] } });
    const request = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected Artifact HTTP'));
    try {
      const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
        sessionId: 'session', mode: 'plain', ctx: null,
        actionsSettingsProvider: { getAccountSettings: () => settings,
          getActionsSettings: () => normalizeActionsSettingsV1(settings.actionsSettingsV1) },
      });
      expect(await deps.promptInvocationsList?.({})).toMatchObject({ coverage: 'complete', items: [{ id: 'local' }] });
      expect(await deps.promptInvocationResolve?.({ invocationId: 'local', sessionId: null }))
        .toEqual({ status: 'unavailable', invocationId: 'local' });
      expect(request).not.toHaveBeenCalled();
    } finally { request.mockRestore(); }
  });
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

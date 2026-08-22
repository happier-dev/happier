import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsAdministration = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock('@/plugins/settings/administration', () => ({
  executePluginSettingsAdministrationAction: settingsAdministration.execute,
}));

import { createCliActionDeps } from './createCliActionDeps';

describe('createCliActionDeps plugin caller forwarding', () => {
  beforeEach(() => {
    settingsAdministration.execute.mockReset();
  });

  it('preserves the canonical host-stamped caller for Settings administration', async () => {
    settingsAdministration.execute.mockResolvedValue({
      ok: true,
      kind: 'plugins.settings.list',
      data: {
        scope: { kind: 'account' },
        target: { kind: 'account' },
        revision: '1',
        fields: [],
      },
    });
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const caller = {
      kind: 'plugin' as const,
      pluginId: 'acme.author',
      contributionLocalId: 'settings-surface',
    };
    const signal = new AbortController().signal;
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });
    const settingsAction = deps.pluginSettingsAdministrationAction;
    expect(settingsAction).toBeDefined();

    await expect(settingsAction!({
      actionId: 'plugins.settings.list',
      input: {
        pluginId: 'acme.settings',
        scope: { kind: 'account' },
        target: { kind: 'account' },
      },
      context: {
        surface: 'cli',
        actionCaller: caller,
        signal,
      },
    })).resolves.toMatchObject({ ok: true, kind: 'plugins.settings.list' });

    expect(settingsAdministration.execute).toHaveBeenCalledWith(expect.objectContaining({
      actionCaller: caller,
      signal,
    }));
  });
});

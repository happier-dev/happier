import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('configuration shell bridge context env mode', () => {
  let envScope = createEnvKeyScope([
    'HAPPIER_SHELL_BRIDGE_CONTEXT_ENV',
  ] as const);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope([
      'HAPPIER_SHELL_BRIDGE_CONTEXT_ENV',
    ] as const);
    vi.resetModules();
  });

  it('defaults shell bridge context env mode to off', async () => {
    envScope.patch({
      HAPPIER_SHELL_BRIDGE_CONTEXT_ENV: undefined,
    });
    vi.resetModules();

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    expect(configMod.configuration.shellBridgeContextEnvMode).toBe('off');
  });

  it('accepts home and full shell bridge context env modes', async () => {
    envScope.patch({
      HAPPIER_SHELL_BRIDGE_CONTEXT_ENV: 'home',
    });
    vi.resetModules();

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    expect(configMod.configuration.shellBridgeContextEnvMode).toBe('home');

    envScope.patch({
      HAPPIER_SHELL_BRIDGE_CONTEXT_ENV: 'full',
    });
    configMod.reloadConfiguration();

    expect(configMod.configuration.shellBridgeContextEnvMode).toBe('full');
  });

  it('normalizes invalid shell bridge context env modes to off', async () => {
    envScope.patch({
      HAPPIER_SHELL_BRIDGE_CONTEXT_ENV: 'yes',
    });
    vi.resetModules();

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    expect(configMod.configuration.shellBridgeContextEnvMode).toBe('off');
  });
});

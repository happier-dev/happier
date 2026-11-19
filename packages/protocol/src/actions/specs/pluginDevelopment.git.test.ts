import { describe, expect, it } from 'vitest';

import { PluginInstallActionInputSchema } from './pluginDevelopment.js';

describe('plugins.install Git input', () => {
  it('accepts a repository or catalog pointer but refuses a version pin', () => {
    const source = { kind: 'git', locator: 'https://github.com/example/plugin', subdirectory: 'plugins/help' };
    expect(PluginInstallActionInputSchema.safeParse({ source, machineId: 'home' }).success).toBe(true);
    expect(PluginInstallActionInputSchema.safeParse({ source: { kind: 'gitCatalog', sourceId: 'vendor', itemId: 'help' }, machineId: 'home' }).success).toBe(true);
    expect(PluginInstallActionInputSchema.safeParse({ source: { ...source, ref: 'old-tag' }, machineId: 'home' }).success).toBe(false);
    expect(PluginInstallActionInputSchema.safeParse({ source: { ...source, subdirectory: '../other' }, machineId: 'home' }).success).toBe(false);
  });
});

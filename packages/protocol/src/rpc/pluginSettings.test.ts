import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './index.js';

describe('RPC_METHODS plugin settings surface', () => {
  it('defines daemon plugin settings get and set methods', () => {
    expect(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET).toBe('daemon.plugins.settings.get');
    expect(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET).toBe('daemon.plugins.settings.set');
  });
});

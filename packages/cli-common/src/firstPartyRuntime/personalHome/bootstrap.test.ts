import { describe, expect, it, vi } from 'vitest';
import { runPersonalHomeBootstrap } from './bootstrap.js';

describe('runPersonalHomeBootstrap', () => {
  it('performs loopback account creation, signup closure, restart, and listener verification in order', async () => {
    const order: string[] = [];
    let managedEnv = 'PORT=43123\nAUTH_ANONYMOUS_SIGNUP_ENABLED=1\n';
    const deps = {
      bindLoopback: async () => { order.push('bind'); },
      resolveNonCollidingPort: async () => { order.push('resolve'); return 43123; },
      readPersistedPort: async () => null,
      persistPort: async () => { order.push('persist'); },
      createLocalAccount: async () => { order.push('account'); return { token: 't', secret: 's' }; },
      readManagedEnv: vi.fn(async () => managedEnv),
      writeManagedEnv: async (text: string) => { order.push('write'); managedEnv = text; },
      restartHome: async () => { order.push('restart'); },
      readEffectivePolicy: async () => '0',
      readListenerOrigin: async () => { order.push('listener'); return 'http://127.0.0.1:43123'; },
    };
    const result = await runPersonalHomeBootstrap(deps);
    expect(result.canonicalServerUrl).toBe('http://127.0.0.1:43123');
    expect(order).toEqual(['bind', 'resolve', 'persist', 'write', 'account', 'write', 'restart', 'listener']);
    expect(deps.readManagedEnv).toHaveBeenCalledTimes(3);
  });
});

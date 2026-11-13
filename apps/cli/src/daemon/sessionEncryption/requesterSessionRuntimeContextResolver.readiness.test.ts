import { describe, expect, it } from 'vitest';

import {
  createRequesterSessionRuntimeContextResolver,
  type AdmittedRequesterSessionBootstrap,
  type RequesterSessionRuntimeContext,
} from './requesterSessionCredentials';

// A daemon that is still starting cannot create requester runtimes yet. A Session it must
// respawn meanwhile (a host update hands its Sessions over during startup) is not "without
// custody": the resolver waits for the daemon's runtime factory instead of answering null,
// which the launch reads as a definite `requester_session_custody_unavailable` refusal.
describe('requester runtime resolver while the daemon is starting', () => {
  const attribution = { serverId: 'home', accountId: 'account', machineId: 'machine', installationId: 'installation' };
  // The recovered custody file and the runtime factory are the resolver's injected boundaries.
  const bootstrap = { attribution, savedSecretOperationContext: { withdrawCatalog() {} } } as unknown as AdmittedRequesterSessionBootstrap;
  const context = { bootstrap } as unknown as RequesterSessionRuntimeContext;

  const setup = () => {
    let factory: ((b: AdmittedRequesterSessionBootstrap) => Promise<RequesterSessionRuntimeContext | null>) | null = null;
    let markCreatable!: () => void;
    const creatable = new Promise<void>(resolve => { markCreatable = resolve; });
    const resolve = createRequesterSessionRuntimeContextResolver({
      trackedSessions: new Map(),
      getCreateRuntime: () => factory,
      whenRuntimeCreatable: async (signal) => {
        await Promise.race([creatable, new Promise<void>(done => signal?.addEventListener('abort', () => done(), { once: true }))]);
      },
      recoverBootstrap: async () => bootstrap,
    });
    return { resolve, ready: () => { factory = async () => context; markCreatable(); } };
  };

  it('resolves the Session runtime once the daemon can create it', async () => {
    const { resolve, ready } = setup();
    const resolving = resolve('session', attribution);
    ready();
    expect(await resolving).toBe(context);
  });

  it('answers null when the wait is cancelled before the daemon is ready', async () => {
    const { resolve } = setup();
    const controller = new AbortController();
    const resolving = resolve('session', attribution, controller.signal);
    controller.abort();
    expect(await resolving).toBeNull();
  });
});

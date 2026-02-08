import { describe, expect, it, vi } from 'vitest';

import { createAcpRuntime } from './createAcpRuntime';
import {
  createApprovedPermissionHandler,
  createBasicSessionClient,
  createDeferred,
  createFakeAcpRuntimeBackend,
} from './createAcpRuntime.testHelpers';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

describe('createAcpRuntime (ensureBackend)', () => {
  it('creates the backend at most once under concurrent calls', async () => {
    const backendReady = createDeferred<void>();
    const backend = createFakeAcpRuntimeBackend();
    const ensureBackend = vi.fn(async () => {
      await backendReady.promise;
      return backend;
    });

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend,
    });

    const first = runtime.startOrLoad({ resumeId: null });
    const second = runtime.startOrLoad({ resumeId: null });
    await Promise.resolve();
    expect(ensureBackend).toHaveBeenCalledTimes(1);
    backendReady.resolve(undefined);
    await Promise.all([first, second]);

    expect(ensureBackend).toHaveBeenCalledTimes(1);
  });
});

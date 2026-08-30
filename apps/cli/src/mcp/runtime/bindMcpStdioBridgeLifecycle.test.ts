import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { bindMcpStdioBridgeLifecycle } from './bindMcpStdioBridgeLifecycle';

describe('bindMcpStdioBridgeLifecycle', () => {
  it('closes the bridge and upstream client once when provider stdin ends', async () => {
    const stdin = new EventEmitter();
    const closeServer = vi.fn(async () => undefined);
    const closeUpstream = vi.fn(async () => undefined);
    const transport: { onclose?: () => void } = {};

    bindMcpStdioBridgeLifecycle({ stdin, transport, closeServer, closeUpstream });
    stdin.emit('end');
    transport.onclose?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(closeUpstream).toHaveBeenCalledTimes(1);
  });
});

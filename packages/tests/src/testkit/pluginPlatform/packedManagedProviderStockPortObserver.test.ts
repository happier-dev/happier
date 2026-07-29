import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  startPackedManagedProviderStockPortObserver,
} from '../../plugin-platform/packedManagedProviderComposedRuntime';

const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(stops.splice(0).map(async (stop) => await stop()));
});

describe('packed managed Provider stock-port OS boundary', () => {
  it('passively observes an owned client process without owning the listener', async () => {
    const target = createServer();
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    stops.push(async () => {
      const closed = once(target, 'close').catch(() => undefined);
      target.close();
      await closed;
    });
    const address = target.address();
    if (!address || typeof address === 'string') {
      throw new Error('stock-port observer target did not bind');
    }
    const observer = await startPackedManagedProviderStockPortObserver({
      port: address.port,
    });
    stops.push(async () => {
      await observer.stop();
    });

    const client = spawn(process.execPath, [
      '-e',
      [
        "const { connect } = require('node:net');",
        `const socket = connect(${address.port}, '127.0.0.1');`,
        "socket.once('connect', () => process.stdout.write('connected\\n'));",
        'setInterval(() => {}, 1_000);',
      ].join(''),
    ], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    if (!client.pid || !client.stdout) {
      throw new Error('stock-port observer client did not start');
    }
    stops.push(async () => {
      if (client.exitCode === null) client.kill();
      if (client.exitCode === null) await once(client, 'exit');
    });
    observer.observeOwnedProcess(client.pid);
    await once(client.stdout, 'data');
    const observed = await observer.snapshot();

    expect(observed.ownedConnectionAttemptCount).toBeGreaterThan(0);
    expect(observed.observedOwnedPids).toContain(client.pid);
    expect(observed.observedOwnedPids).not.toContain(process.pid);
  }, 20_000);
});

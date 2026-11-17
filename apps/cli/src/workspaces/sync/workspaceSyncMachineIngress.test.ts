import { once } from 'node:events';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { openWorkspaceSyncMachineIngress } from './workspaceSyncMachineIngress';

it('carries binary provider bytes through the existing one-use loopback ingress', async () => {
  // The provider process boundary owns this stream. Its guest root does not
  // exist in the carrier filesystem and is opaque to the listener.
  const guestRoot = '/native-guest-only/checkout';
  const stream = new PassThrough();
  let stopped = false;
  const openedRoots: string[] = [];
  const ingress = await openWorkspaceSyncMachineIngress({}, { openAgent: async () => {
    openedRoots.push(guestRoot);
    return { stream, stop: async () => { stopped = true; } };
  } });
  const client = connect({ host: '127.0.0.1', port: ingress.port });
  try {
    await once(client, 'connect');
    const bytes = Buffer.from([0, 255, 128, 10, 0, 1]);
    const response = once(client, 'data');
    client.write(Buffer.concat([Buffer.from(ingress.localCapability), bytes]));
    expect((await response)[0]).toEqual(bytes);
    expect(openedRoots).toEqual([guestRoot]);
  } finally {
    client.destroy();
    await ingress.close();
  }
  expect(stopped).toBe(true);
});

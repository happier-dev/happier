import { describe, expect, it } from 'vitest';
import { createLumeNativeClientForTest as createLumeNativeClient } from './nativeClient.testkit.js';

const source = { storage: 'prepared bases', vmName: 'happier-prepared-operation' };
const destination = { storage: 'sandbox guests', vmName: 'happier-session' };

describe('Lume native clone boundary (lume-v0.6.1)', () => {
  it('clones the exact base and destination storage identities', async () => {
    const requests: unknown[] = [];
    const request: typeof fetch = async (url, init) => {
      expect(new URL(String(url)).pathname).toBe('/lume/vms/clone');
      expect(init?.method).toBe('POST');
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ message: 'VM cloned successfully', source: source.vmName, destination: destination.vmName });
    };
    const native = createLumeNativeClient({ baseUrl: 'http://127.0.0.1:7777', fetch: request });
    expect(await native.clone(source, destination)).toEqual({ kind: 'clone-accepted', resource: destination });
    expect(requests).toEqual([{ name: source.vmName, newName: destination.vmName,
      sourceLocation: source.storage, destLocation: destination.storage }]);
  });

  it.each([
    { source: 'another-base', destination: destination.vmName },
    { source: source.vmName, destination: 'another-guest' },
    {},
  ])('retains the destination without accepting an uncorrelated clone response %#', async response => {
    const request: typeof fetch = async () => Response.json(response);
    const native = createLumeNativeClient({ baseUrl: 'http://127.0.0.1:7777', fetch: request });
    expect(await native.clone(source, destination)).toEqual({ kind: 'unknown', reason: 'response', resource: destination });
  });

  it('retains uncertain clone identity without replaying the native mutation', async () => {
    const effects: unknown[] = [];
    const request: typeof fetch = async (_url, init) => {
      effects.push(JSON.parse(String(init?.body)));
      throw new Error('response lost after native clone');
    };
    const native = createLumeNativeClient({ baseUrl: 'http://127.0.0.1:7777', fetch: request });
    expect(await native.clone(source, destination)).toEqual({ kind: 'unknown', reason: 'transport', resource: destination });
    expect(effects).toHaveLength(1);
  });
});

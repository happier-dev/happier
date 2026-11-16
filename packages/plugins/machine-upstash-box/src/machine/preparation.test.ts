import { describe, expect, it } from 'vitest';
import { createUpstashBoxPreparationClient } from './preparation.js';

const launch = { runtime: 'node', size: 'small' } as const;
const input = { operationId: 'cancelled', input: { launch: { provider: { pluginId: 'happier.machine.upstash-box', localId: 'upstash-box' }, schemaVersion: 1, choices: launch },
  cli: { identity: 'release:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier', installScript: 'false', files: [] } } };

describe('Upstash native preparation recovery', () => {
  it('retains a cancelled creating source for a fresh cleanup invocation without starting setup or another build', async () => {
    const controller = new AbortController(); let present = false, cancel = true;
    const calls: string[] = [];
    const request: typeof fetch = async (url, init) => {
      init?.signal?.throwIfAborted();
      const path = new URL(String(url)).pathname, method = init?.method ?? 'GET';
      calls.push(method + ' ' + path);
      if (path.endsWith('/snapshots')) return Response.json({ snapshots: [] });
      if (method === 'DELETE') { present = false; return Response.json({}); }
      if (method === 'POST') present = true;
      const response = present ? Response.json({ id: 'builder', name: 'happier-prepared-cancelled',
        labels: ['happier-managed'], status: 'creating' }) : Response.json({}, { status: 404 });
      if (method === 'GET' && cancel) { cancel = false; controller.abort(); }
      return response;
    };
    const built = await createUpstashBoxPreparationClient(request, controller.signal).build(input);
    expect(built).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { sourceBoxId: 'builder' } } });
    if (built.kind !== 'unknown') throw new Error('Missing interrupted build');
    const recovered = await createUpstashBoxPreparationClient(request).inspect({ operationId: 'cancelled', launch });
    expect(recovered).toMatchObject({ kind: 'failed', code: 'upstash_box_preparation_incomplete' });
    expect(await createUpstashBoxPreparationClient(request).destroy({ nativeOperation: built.nativeOperationRef.value })).toEqual({ kind: 'confirmed' });
    expect(calls.filter(call => call.startsWith('POST '))).toEqual(['POST /v2/box']);
    expect(present).toBe(false);
  });

  it('keeps exact native HTTP refusal codes without leaking the vendor body', async () => {
    const request: typeof fetch = async () => Response.json({ error: 'private-account-detail' }, { status: 403 });
    const client = createUpstashBoxPreparationClient(request);
    expect(await client.build(input)).toEqual({ kind: 'refused', code: 'credential_unavailable' });
    const inspection = await client.inspect({ operationId: 'cancelled', launch });
    expect(inspection).toMatchObject({ kind: 'unknown', code: 'credential_unavailable' });
    expect(JSON.stringify(inspection)).not.toContain('private-account-detail');
  });
});

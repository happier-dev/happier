import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { getActionSpec, listActionSpecRpcRegistrations, listActionSpecs } from './actionSpecs.js';

// Retained-bytes contract (P03-CODE-COVERAGE): the daemon and the session host
// register Action RPC handlers at boot and look up a few specs by id. Neither
// may build the whole normalized catalog (~9 MiB live per process, P03-BOOT-HEAP);
// only a later full listing may. A quarter of that separates the two.
const MIN_FULL_LISTING_BYTES = 2 * 2 ** 20;

describe('Action RPC registration index', () => {
  it('registers RPC methods and resolves one spec without building the normalized catalog', () => {
    const entry = new URL('./actionSpecs.ts', import.meta.url).href;
    const code = [
      'const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };',
      `const catalog = await import(${JSON.stringify(entry)});`,
      'const registrations = catalog.listActionSpecRpcRegistrations().length;',
      "const spec = catalog.getActionSpec('session.spawn_new').id;",
      'const before = heap();',
      'const count = catalog.listActionSpecs().length;',
      'console.log(JSON.stringify({ registrations, spec, count, fullListingBytes: heap() - before }));',
    ].join('\n');
    const output = execFileSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      encoding: 'utf8',
      maxBuffer: 16 << 20,
    });
    const result = JSON.parse(output.trim().split('\n').at(-1)!) as { registrations: number; spec: string; count: number; fullListingBytes: number };
    expect(result.registrations).toBeGreaterThan(0);
    expect(result.spec).toBe('session.spawn_new');
    expect(result.fullListingBytes).toBeGreaterThan(MIN_FULL_LISTING_BYTES);
  }, 120_000);

  it('projects exactly the RPC methods of the normalized catalog, and lookups return the listed rows', () => {
    const fromCatalog = listActionSpecs()
      .filter((spec) => spec.surfaces.rpc === true && spec.bindings?.rpcMethod)
      .map((spec) => [spec.id, spec.bindings?.rpcMethod, [...(spec.bindings?.rpcMethodAliases ?? [])]]);
    const fromIndex = listActionSpecRpcRegistrations()
      .map((row) => [row.id, row.bindings.rpcMethod, [...(row.bindings.rpcMethodAliases ?? [])]]);
    expect(fromIndex).toEqual(fromCatalog);
    for (const spec of listActionSpecs()) expect(getActionSpec(spec.id)).toBe(spec);
  });
});

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Retained-bytes contract: importing the catalog module must not build the
// catalog. Every process that imports a spec helper (daemon, session host,
// worker, CLI) would otherwise keep the whole normalized catalog alive. The
// first read is where it is built: measured ~9 MiB of live heap on the shipped
// bundle (P03-BOOT-HEAP), so a quarter of that separates "built on first
// read" from "already built at import" well above post-GC noise.
const MIN_FIRST_READ_BYTES = 2 * 2 ** 20;

describe('Action catalog evaluation', () => {
  it('builds the catalog on its first read, not when the module is imported', () => {
    const entry = new URL('./actionSpecs.ts', import.meta.url).href;
    const code = [
      'const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };',
      `const catalog = await import(${JSON.stringify(entry)});`,
      'const afterImport = heap();',
      'const count = catalog.listActionSpecs().length;',
      'console.log(JSON.stringify({ count, firstReadBytes: heap() - afterImport }));',
    ].join('\n');
    const output = execFileSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      encoding: 'utf8',
      maxBuffer: 16 << 20,
    });
    const { count, firstReadBytes } = JSON.parse(output.trim().split('\n').at(-1)!) as { count: number; firstReadBytes: number };
    expect(count).toBeGreaterThan(0);
    expect(firstReadBytes).toBeGreaterThan(MIN_FIRST_READ_BYTES);
  }, 120_000);
});

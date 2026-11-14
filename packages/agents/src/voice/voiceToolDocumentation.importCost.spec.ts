import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Retained-bytes contract (P03-BOOT-HEAP): the daemon and session host import
// this module, so evaluating it must not build the whole Action catalog. The
// catalog's first read costs ~9 MiB of live heap on the shipped bundle; a
// quarter of that separates "built on first read" from "built at import".
const MIN_FIRST_READ_BYTES = 2 * 2 ** 20;

describe('voice tool documentation module', () => {
  it('leaves the Action catalog unbuilt until something reads it', () => {
    const entry = new URL('./voiceToolDocumentation.ts', import.meta.url).href;
    const code = [
      'const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };',
      `await import(${JSON.stringify(entry)});`,
      "const catalog = await import('@happier-dev/protocol/actions/actionSpecs');",
      'const afterImport = heap();',
      'const count = catalog.listActionSpecs().length;',
      'console.log(JSON.stringify({ count, firstReadBytes: heap() - afterImport }));',
    ].join('\n');
    const output = execFileSync(process.execPath, [
      '--expose-gc', '--conditions=happier-source', '--import', 'tsx', '--input-type=module', '-e', code,
    ], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      encoding: 'utf8',
      maxBuffer: 16 << 20,
    });
    const { count, firstReadBytes } = JSON.parse(output.trim().split('\n').at(-1)!) as { count: number; firstReadBytes: number };
    expect(count).toBeGreaterThan(0);
    expect(firstReadBytes).toBeGreaterThan(MIN_FIRST_READ_BYTES);
  }, 120_000);
});

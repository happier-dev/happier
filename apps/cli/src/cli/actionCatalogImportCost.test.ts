import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Retained-bytes contract (P03-BOOT-HEAP): the daemon and session host import
// these modules, so evaluating them must not build the whole Action catalog.
// The catalog's first read costs ~9 MiB of live heap on the shipped bundle; a
// quarter of that separates "built on first read" from "built at import".
const MIN_FIRST_READ_BYTES = 2 * 2 ** 20;
const cliRoot = fileURLToPath(new URL('../..', import.meta.url));

function measureCatalogFirstReadBytesAfterImporting(modulePath: string): { count: number; firstReadBytes: number } {
  const entry = new URL(modulePath, new URL('../', import.meta.url)).href;
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
  ], { cwd: cliRoot, encoding: 'utf8', maxBuffer: 16 << 20 });
  return JSON.parse(output.trim().split('\n').at(-1)!) as { count: number; firstReadBytes: number };
}

describe('Action catalog stays unbuilt when daemon modules are imported', () => {
  it.each([
    'api/machine/machineRpcAuthorization.ts',
    'agent/tools/happierTools/catalog.ts',
    'agent/tools/happierTools/actionToolCatalog.ts',
    'agent/tools/happierTools/resolveHappierActionForMcpToolName.ts',
    'agent/runtime/session/input/sessionProviderInputAdmissionRpc.ts',
  ])('%s', (modulePath) => {
    const { count, firstReadBytes } = measureCatalogFirstReadBytesAfterImporting(modulePath);
    expect(count).toBeGreaterThan(0);
    expect(firstReadBytes).toBeGreaterThan(MIN_FIRST_READ_BYTES);
  }, 180_000);
});

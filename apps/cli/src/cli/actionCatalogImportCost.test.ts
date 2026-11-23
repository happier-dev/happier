import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// Retained-bytes contract (P03-BOOT-HEAP): the daemon and session host import
// these modules, so evaluating them must not build the whole Action catalog.
// The catalog's first read costs ~9 MiB of live heap on the shipped bundle; a
// quarter of that separates "built on first read" from "built at import".
const MIN_FIRST_READ_BYTES = 2 * 2 ** 20;
const cliRoot = fileURLToPath(new URL('../..', import.meta.url));
const execFileAsync = promisify(execFile);

type CatalogHeapSample = {
  count: number;
  firstReadBytes: number;
  operationBytes: number;
  result: unknown;
};

async function measureCatalogFirstReadBytesAfterImporting(
  modulePath: string,
  permissionLookup?: { toolName: string; input: Record<string, unknown> },
): Promise<CatalogHeapSample> {
  const entry = new URL(modulePath, new URL('../', import.meta.url)).href;
  const code = [
    'const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };',
    `const entry = await import(${JSON.stringify(entry)});`,
    "const catalog = await import('@happier-dev/protocol/actions/actionSpecs');",
    'const afterImport = heap();',
    permissionLookup
      ? `const result = entry.resolveProviderPermissionForHappierAction(${JSON.stringify({ ...permissionLookup, permissionMode: 'default' })});`
      : 'const result = null;',
    permissionLookup ? 'const afterOperation = heap();' : 'const afterOperation = afterImport;',
    'const count = catalog.listActionSpecs().length;',
    'const firstReadBytes = heap() - afterOperation;',
    'console.log(JSON.stringify({ count, firstReadBytes, operationBytes: afterOperation - afterImport, result }));',
  ].join('\n');
  const { stdout } = await execFileAsync(process.execPath, [
    '--expose-gc', '--conditions=happier-source', '--import', 'tsx', '--input-type=module', '-e', code,
  ], { cwd: cliRoot, encoding: 'utf8', maxBuffer: 16 << 20 });
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as CatalogHeapSample;
}

describe('Action catalog stays unbuilt when daemon modules are imported', () => {
  it.each([
    'api/machine/machineRpcAuthorization.ts',
    'agent/tools/happierTools/catalog.ts',
    'agent/tools/happierTools/actionToolCatalog.ts',
    'agent/tools/happierTools/resolveHappierActionForMcpToolName.ts',
    'agent/runtime/session/input/sessionProviderInputAdmissionRpc.ts',
  ])('%s', async (modulePath) => {
    const { count, firstReadBytes } = await measureCatalogFirstReadBytesAfterImporting(modulePath);
    expect(count).toBeGreaterThan(0);
    expect(firstReadBytes).toBeGreaterThan(MIN_FIRST_READ_BYTES);
  }, 180_000);
});

describe('Happier Action permission lookup', () => {
  it('leaves the rest of the Action catalog lazy after resolving one Action', async () => {
    const { count, firstReadBytes, result } = await measureCatalogFirstReadBytesAfterImporting(
      'agent/tools/happierTools/resolveHappierActionForMcpToolName.ts',
      { toolName: 'happier_action_execute', input: { actionId: 'session.status.get' } },
    );
    expect(result).toEqual({ decision: 'approved', actionId: 'session.status.get' });
    expect(count).toBeGreaterThan(0);
    expect(firstReadBytes).toBeGreaterThan(MIN_FIRST_READ_BYTES);
  }, 180_000);
});

describe('Named Happier tool permission lookup', () => {
  it('resolves one tool without retaining the remaining tool catalog', async () => {
    const { operationBytes, result } = await measureCatalogFirstReadBytesAfterImporting(
      'agent/tools/happierTools/resolveHappierActionForMcpToolName.ts',
      { toolName: 'mcp__happier__session_list', input: {} },
    );
    expect(result).toEqual({ decision: 'approved', actionId: 'session.list' });
    expect(operationBytes).toBeLessThan(MIN_FIRST_READ_BYTES);
  }, 180_000);
});

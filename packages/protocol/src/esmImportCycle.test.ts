import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { describe, it } from 'vitest';

// This test intentionally pays the full startup cost of a fresh `node --import tsx` process.
// Keep ample headroom so full-suite lane contention does not look like an import-cycle regression.
const MODULE_IMPORT_TIMEOUT_MS = 60_000;
const execFileAsync = promisify(execFile);

async function importInFreshProcess(relativeEntryPath: string, afterImport = '', sourceRuntime = false): Promise<void> {
  const entryUrl = pathToFileURL(path.join(__dirname, relativeEntryPath)).href;
  const script = `await import(${JSON.stringify(entryUrl)}); ${afterImport}`;

  // Keep Vitest's worker responsive while the full native graph initializes.
  // execFile rejects on a nonzero exit, signal or timeout with child diagnostics.
  const loader = sourceRuntime
    ? ['--conditions=happier-source', '--import', path.join(__dirname, '../../cli-common/registerSourceRuntime.mjs')]
    : ['--import', 'tsx'];
  await execFileAsync(process.execPath, [...loader, '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: MODULE_IMPORT_TIMEOUT_MS,
  });
}

describe('protocol ESM import safety', () => {
  it.each(['actions/operations/v1.ts', 'actions/specs/actionOperations.ts', 'plugins/contributions/v2.ts', 'plugins/contributions/machineProvisioners.ts'])(
    'projects Action operations with %s first under the fresh public CLI source runtime', async (entryPath) => {
      const specs = pathToFileURL(path.join(__dirname, 'actions/specs/actionOperations.ts')).href;
      const projector = pathToFileURL(path.join(__dirname, 'actions/actionInputJsonSchema.ts')).href;
      await importInFreshProcess(entryPath, `
        const { strict: assert } = await import('node:assert');
        const { ACTION_OPERATION_ACTION_SPECS } = await import(${JSON.stringify(specs)});
        const { zodSchemaToJsonSchemaObject } = await import(${JSON.stringify(projector)});
        for (const spec of ACTION_OPERATION_ACTION_SPECS) {
          assert.ok(spec.inputSchema, spec.id + ' input');
          assert.ok(spec.outputSchema, spec.id + ' output');
          zodSchemaToJsonSchemaObject(spec.inputSchema);
          zodSchemaToJsonSchemaObject(spec.outputSchema);
        }
        assert.equal(ACTION_OPERATION_ACTION_SPECS.find(spec => spec.id === 'action.operations.cancel').bindings.rpcMethod,
          'actionOperation.cancel.v1');
      `, true);
    }, MODULE_IMPORT_TIMEOUT_MS + 5_000);

  it.each([
    'actions/actionIds.ts',
    'actions/pluginActionSurface.ts',
    'index.ts',
    'actions/npmRegistryProfileActionFamily.ts',
    'plugins/contributions/ui/v2.ts',
    'deployments/deploymentDomainV1.ts',
  ])(
    'imports %s in a fresh process without Action catalog initialization errors',
    async (entryPath) => {
      await importInFreshProcess(entryPath);
    },
    MODULE_IMPORT_TIMEOUT_MS + 5_000,
  );

  it(
    'imports executionRuns under node + tsx without initialization errors',
    async () => {
      await importInFreshProcess('execution/runs/index.ts');
    },
    MODULE_IMPORT_TIMEOUT_MS + 5_000
  );

  it.each([
    'connect/connectedAccountPurposes.ts',
    'connect/connectedServiceSchemas.ts',
  ])(
    'imports %s in a fresh process without connected-service initialization errors',
    async (entryPath) => {
      await importInFreshProcess(entryPath);
    },
    MODULE_IMPORT_TIMEOUT_MS + 5_000,
  );
});

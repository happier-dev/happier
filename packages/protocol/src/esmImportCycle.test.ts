import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

// This test intentionally pays the full startup cost of a fresh `node --import tsx` process.
// Keep ample headroom so full-suite lane contention does not look like an import-cycle regression.
const EXECUTION_RUNS_IMPORT_TIMEOUT_MS = 60_000;

describe('protocol ESM import safety', () => {
  it(
    'imports executionRuns under node + tsx without initialization errors',
    () => {
      const entryUrl = pathToFileURL(path.join(__dirname, 'executionRuns.ts')).href;
      const script = `import(${JSON.stringify(entryUrl)})`;

      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: EXECUTION_RUNS_IMPORT_TIMEOUT_MS,
      });

      const diagnostics = [
        `status=${String(result.status)}`,
        `signal=${String(result.signal)}`,
        `error=${result.error ? result.error.message : 'none'}`,
        `stderr=${result.stderr?.trim() || '<empty>'}`,
      ].join('\n');

      expect(result.error, diagnostics).toBeUndefined();
      expect(result.signal, diagnostics).toBeNull();
      expect(result.status, diagnostics).toBe(0);
    },
    EXECUTION_RUNS_IMPORT_TIMEOUT_MS + 5_000
  );
});

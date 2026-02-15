import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('protocol ESM import safety', () => {
  it('imports executionRuns under node + tsx without initialization errors', () => {
    const entryUrl = pathToFileURL(path.join(__dirname, 'executionRuns.ts')).href;
    const script = `import(${JSON.stringify(entryUrl)})`;

    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
  });
});

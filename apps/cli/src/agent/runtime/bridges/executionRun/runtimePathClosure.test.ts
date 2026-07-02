import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function repoPath(path: string): string {
  const cwd = process.cwd();
  const root = existsSync(resolve(cwd, 'apps/cli/package.json'))
    ? cwd
    : resolve(cwd, '../..');
  return resolve(root, path);
}

describe('execution-run runtime path closure', () => {
  it('keeps runtime construction under the execution-run bridge owner', () => {
    expect(existsSync(repoPath('apps/cli/src/agent/runtime/bridges/executionRun/runtime/create.ts'))).toBe(true);
    expect(existsSync(repoPath('apps/cli/src/agent/executionRuns/runtime/createExecutionRunRuntime.ts'))).toBe(false);
  });

  it('does not retain Claude host execution-run runtime owners', () => {
    expect(existsSync(repoPath('apps/cli/src/backends/claude/executionRuns/executionRunBackendFactory.ts'))).toBe(false);
    expect(existsSync(repoPath('apps/cli/src/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend.ts'))).toBe(false);
  });
});

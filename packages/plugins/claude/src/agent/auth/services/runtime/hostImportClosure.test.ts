import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../../../../../', import.meta.url));

const remainingHostRuntimeFiles = [
  'apps/cli/src/backends/claude/runtime/remote/createLaunchController.ts',
  'apps/cli/src/backends/claude/runtime/terminal/createLaunchController.ts',
] as const;

const streamLoopFile = 'apps/cli/src/backends/claude/remote/sdk/runClaudeAgentSdkStreamLoop.ts';

describe('Claude runtime auth host import closure', () => {
  it('does not keep legacy host terminal or remote launch controllers', () => {
    for (const file of remainingHostRuntimeFiles) {
      expect(existsSync(new URL(file, `file://${repoRoot}`)), file).toBe(false);
    }
  });

  it('keeps the remaining host SDK stream loop on plugin-owned runtime auth classification', async () => {
    const source = await readFile(new URL(streamLoopFile, `file://${repoRoot}`), 'utf8');

    expect(source).not.toContain('../../connectedServices/mapClaudeRateLimitEventToUsageDetails');
    expect(source).not.toContain('../../connectedServices/createClaudeConnectedServiceRuntimeAuthAdapter');
    expect(source).toContain('@happier-dev/plugins-claude/agent/auth/services/runtime');
  });
});

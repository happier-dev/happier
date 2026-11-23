import { constants } from 'node:fs';
import { access, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { installAgentCli } from './install.js';

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin').each(['muse', 'coderabbit'] as const)('%s vendor install', (agentId) => {
  it.each(['missing', 'failed', 'successful'] as const)('reports a %s download through the installer', async (download) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-vendor-recipe-'));
    try {
      await symlink('/bin/bash', join(home, 'bash'));
      await symlink('/bin/sh', join(home, 'sh'));
      const installedCli = join(home, agentId);
      if (download !== 'missing') {
        // The curl executable is the download boundary. Its output is a local installer fixture.
        const fixture = download === 'failed'
          ? "printf 'fixture download failed\\n' >&2\nexit 22\n"
          : `/bin/cat <<'INSTALLER'
printf '#!/bin/sh\\n' > "$HOME/$FIXTURE_AGENT" && /bin/chmod +x "$HOME/$FIXTURE_AGENT"
INSTALLER
`;
        await writeFile(join(home, 'curl'), '#!/bin/bash\n' + fixture, { mode: 0o755 });
      }
      const result = await installAgentCli({
        agentId,
        platform: 'linux',
        env: { HOME: home, PATH: home, HAPPIER_HOME_DIR: home, FIXTURE_AGENT: agentId },
        logDir: home,
        skipIfInstalled: false,
        allowVendorRecipeExecution: true,
      });

      if (download === 'successful') {
        expect(result).toMatchObject({ ok: true });
        await access(installedCli, constants.X_OK);
      } else {
        expect(result).toMatchObject({
          ok: false,
          errorCode: 'command-failed',
          errorMessage: expect.stringMatching(download === 'missing' ? /curl: (?:command )?not found/ : /fixture download failed/),
        });
        await expect(access(installedCli)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

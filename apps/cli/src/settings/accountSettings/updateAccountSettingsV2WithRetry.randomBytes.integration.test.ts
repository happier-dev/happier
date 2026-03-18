import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { projectPath } from '@/projectPath';

const nodeRequire = createRequire(import.meta.url);

function resolveTsxLoaderPath(): string {
  const tsxPkgJsonPath = nodeRequire.resolve('tsx/package.json');
  return join(dirname(tsxPkgJsonPath), 'dist', 'esm', 'index.mjs');
}

describe('updateAccountSettingsV2WithRetry source-mode random bytes', () => {
  it('updates encrypted account settings successfully when executed via tsx source mode', () => {
    const cliProjectDir = projectPath();
    const script = `
import { accountSettingsParse, openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { updateAccountSettingsV2WithRetry } from './src/settings/accountSettings/updateAccountSettingsV2WithRetry.ts';

const secret = new Uint8Array(32).fill(7);
const credentials = {
  token: 't',
  encryption: { type: 'legacy', secret },
};

const initialCiphertext = sealAccountScopedBlobCiphertext({
  kind: 'account_settings',
  material: { type: 'legacy', secret },
  payload: { ...accountSettingsParse({ schemaVersion: 2 }), someKey: 'before' },
  randomBytes: () => new Uint8Array(24).fill(1),
});

let postedContent = null;
const result = await updateAccountSettingsV2WithRetry({
  credentials,
  mutate: (settings) => ({ ...settings, someKey: 'after' }),
  deps: {
    fetchSettings: async () => ({
      content: { t: 'encrypted', c: initialCiphertext },
      version: 10,
    }),
    updateSettings: async (req) => {
      postedContent = req.content;
      return { success: true, version: 11 };
    },
  },
});

if (!postedContent || postedContent.t !== 'encrypted') {
  throw new Error('missing encrypted content');
}

const opened = openAccountScopedBlobCiphertext({
  kind: 'account_settings',
  material: { type: 'legacy', secret },
  ciphertext: postedContent.c,
});

console.log(JSON.stringify({
  version: result.version,
  updated: opened?.value?.someKey === 'after',
}));
`;

    const result = spawnSync(
      process.execPath,
      ['--import', resolveTsxLoaderPath(), '-e', script],
      {
        cwd: cliProjectDir,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: join(cliProjectDir, 'tsconfig.json'),
        },
        encoding: 'utf-8',
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ version: 11, updated: true });
  });
});

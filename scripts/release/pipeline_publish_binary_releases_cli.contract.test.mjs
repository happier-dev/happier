import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

for (const { subcommand, scriptName } of [
  { subcommand: 'publish-cli-binaries', scriptName: 'publish-cli-binaries.mjs' },
  { subcommand: 'publish-hstack-binaries', scriptName: 'publish-hstack-binaries.mjs' },
]) {
  for (const channel of ['preview', 'dev']) {
    test(`pipeline CLI can run ${subcommand} dry-run for ${channel} using env-file mode`, async () => {
      const out = execFileSync(
        process.execPath,
        [
          resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
          subcommand,
          '--channel',
          channel,
          '--dry-run',
          '--secrets-source',
          'env',
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            MINISIGN_SECRET_KEY: 'untrusted comment: minisign encrypted secret key\nRWQpH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1',
            MINISIGN_PASSPHRASE: 'x',
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      );

      assert.match(out, new RegExp(`\\[pipeline\\] exec: node .*${scriptName.replace('.', '\\.')}`));
      assert.match(out, /"--channel"/);
      assert.match(out, new RegExp(`"${channel}"`));

      const wrapperSource = fs.readFileSync(resolve(repoRoot, 'scripts', 'pipeline', 'release', scriptName), 'utf8');
      assert.match(wrapperSource, /publishing\/publish-binary-release\.mjs/);
    });
  }
}

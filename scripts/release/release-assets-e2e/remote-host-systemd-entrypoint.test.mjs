import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entrypointPath = join(here, 'bin', 'remote-host-systemd-entrypoint.sh');

test('remote host installer shim installs stack before cli to avoid npm EEXIST on happier bin', () => {
  const content = fs.readFileSync(entrypointPath, 'utf8');

  const stackInstall = 'npm install -g --force /packs/stack.tgz';
  const cliInstall = 'npm install -g --force /packs/cli.tgz';

  const idxStack = content.indexOf(stackInstall);
  const idxCli = content.indexOf(cliInstall);

  assert.ok(idxStack >= 0, `expected entrypoint to include: ${stackInstall}`);
  assert.ok(idxCli >= 0, `expected entrypoint to include: ${cliInstall}`);
  assert.ok(
    idxStack < idxCli,
    `expected stack install to occur before cli install to avoid EEXIST on bin links\n${entrypointPath}`,
  );
});


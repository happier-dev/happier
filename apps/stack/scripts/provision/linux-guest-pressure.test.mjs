import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));

async function writeExecutable(path, source) {
  await writeFile(path, source, 'utf8');
  await chmod(path, 0o755);
}

test('guest pressure reserves swap extents without physically zero-filling the sparse VM disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-guest-pressure-'));
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  const active = join(root, 'swap-active');
  await mkdir(bin);

  await writeExecutable(join(bin, 'id'), '#!/bin/sh\necho 501\n');
  await writeExecutable(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n');
  await writeExecutable(join(bin, 'stat'), [
    '#!/bin/sh',
    'if [ "$1" = "-c" ] && [ "$2" = "%s" ]; then echo 0; exit 0; fi',
    'exit 1',
  ].join('\n'));
  await writeExecutable(join(bin, 'df'), '#!/bin/sh\nprintf "Avail\\n1099511627776\\n"\n');
  await writeExecutable(join(bin, 'awk'), '#!/bin/sh\nexit 0\n');
  await writeExecutable(join(bin, 'swapon'), [
    '#!/bin/sh',
    `if [ "$1" = "--show=NAME" ]; then test -f ${JSON.stringify(active)} && echo /var/lib/happier/swapfile; exit 0; fi`,
    `printf 'swapon %s\\n' "$*" >> ${JSON.stringify(log)}`,
    `: > ${JSON.stringify(active)}`,
  ].join('\n'));
  await writeExecutable(join(bin, 'fallocate'), `#!/bin/sh\nprintf 'fallocate %s\\n' "$*" >> ${JSON.stringify(log)}\n`);
  await writeExecutable(join(bin, 'dd'), `#!/bin/sh\nprintf 'dd %s\\n' "$*" >> ${JSON.stringify(log)}\n`);
  await writeExecutable(join(bin, 'install'), `#!/bin/sh\nprintf 'install %s\\n' "$*" >> ${JSON.stringify(log)}\n`);
  await writeExecutable(join(bin, 'chmod'), `#!/bin/sh\nprintf 'chmod %s\\n' "$*" >> ${JSON.stringify(log)}\n`);
  await writeExecutable(join(bin, 'mkswap'), `#!/bin/sh\nprintf 'mkswap %s\\n' "$*" >> ${JSON.stringify(log)}\n`);
  await writeExecutable(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
  await writeExecutable(join(bin, 'tee'), '#!/bin/sh\ncat >/dev/null\n');
  await writeExecutable(join(bin, 'rm'), [
    '#!/bin/sh',
    'target=""',
    'for argument do target="$argument"; done',
    'case "$target" in /tmp/*|/private/tmp/*) /bin/rm "$@" ;; *) exit 0 ;; esac',
  ].join('\n'));

  const result = spawnSync('bash', [join(here, 'linux-guest-pressure.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      HAPPIER_SWAP_GIB: '64',
      HAPPIER_ZSWAP: '0',
      HAPPIER_SWAP_FREE_RESERVE_GIB: '32',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const commands = await readFile(log, 'utf8');
  assert.match(commands, /fallocate -l 64G \/var\/lib\/happier\/swapfile/);
  assert.doesNotMatch(commands, /^dd /m);
});

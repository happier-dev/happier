import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { commitExtensionBoundaries } from './commitExtensionBoundaries.mjs';

// P03-TYPECHECK-DEBT 2026-11-17: journey tests importing apps/ui source into the packages/tests program (which maps
// `@/*` to apps/cli) produced ~6,000 of 7,239 new typecheck rows. A packet may reach UI code from that program only
// through the `.d.mts` facades; leaving the program through its tsconfig `exclude` is the other canonical route.
test('a packet adding a packages/tests program import of apps/ui source is refused; facades, excluded files and existing imports are not', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'happier-boundaries-tests-ui-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const write = async (path, content) => { await mkdir(dirname(join(repo, path)), { recursive: true }); await writeFile(join(repo, path), content); };
  git('init', '--quiet');
  git('config', 'user.name', 'Boundary Test');
  git('config', 'user.email', 'boundary@example.invalid');
  await write('packages/tests/tsconfig.json', `{
  "compilerOptions": { "paths": { "@/*": ["./../../apps/cli/src/*"] } },
  "include": ["src/**/*.ts", "suites/**/*.ts"],
  // composed tests that import UI and CLI source leave this program
  "exclude": ["node_modules", "suites/excluded.test.ts"]
}
`);
  await write('apps/ui/sources/store/sessions.ts', 'export const sessions = 1;\n');
  await write('apps/ui/sources/dev/testkit/uiFacade.d.mts', 'export declare const facade: number;\n');
  await write('packages/tests/suites/old.test.ts', "import { sessions } from '../../../apps/ui/sources/store/sessions';\nexport const old = sessions;\n");
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  await write('packages/tests/suites/old.test.ts', "import { sessions } from '../../../apps/ui/sources/store/sessions';\nexport const old = sessions + 1;\n");
  await write('packages/tests/suites/new.test.ts', "import type { sessions } from '../../../apps/ui/sources/store/sessions.ts';\nexport type New = typeof sessions;\n");
  await write('packages/tests/src/lazy.ts', "export const lazy = () => import('../../../apps/ui/sources/store/sessions.js');\n");
  await write('packages/tests/suites/facade.test.ts', "import { facade } from '../../../apps/ui/sources/dev/testkit/uiFacade.d.mts';\nexport const f = facade;\n");
  await write('packages/tests/suites/excluded.test.ts', "import { sessions } from '../../../apps/ui/sources/store/sessions';\nexport const e = sessions;\n");
  await write('packages/tests/fixtures/outside.ts', "import { sessions } from '../../../apps/ui/sources/store/sessions';\nexport const o = sessions;\n");
  git('add', '-A');
  git('commit', '--quiet', '-m', 'packet');
  const tree = git('rev-parse', 'HEAD').trim();
  const { findings } = commitExtensionBoundaries({ repo, base, tree });
  assert.deepEqual(findings.sort(), [
    'packages/tests program imports apps/ui source (use a .d.mts facade or the tsconfig exclude): packages/tests/src/lazy.ts -> ../../../apps/ui/sources/store/sessions.js',
    'packages/tests program imports apps/ui source (use a .d.mts facade or the tsconfig exclude): packages/tests/suites/new.test.ts -> ../../../apps/ui/sources/store/sessions.ts',
  ]);
});

import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createTempFixture } from '../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { runNodeCapture } from '../apps/stack/scripts/testkit/core/run_node_capture.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const oxlint = join(repoRoot, 'node_modules/oxlint/bin/oxlint');

test('root lint policy catches defects in authored code and both UI contribution paths', async (t) => {
  const fixture = await createTempFixture(t, {
    prefix: 'happier-oxlint-policy-',
  });
  await copyFile(
    join(repoRoot, '.oxlintrc.json'),
    fixture.path('.oxlintrc.json'),
  );
  await mkdir(fixture.path('apps/ui/sources'), { recursive: true });
  await mkdir(fixture.path('scripts/build'), { recursive: true });
  await mkdir(fixture.path('packages/plugins/example/src/ui'), {
    recursive: true,
  });
  const broken = `import { useState, useMemo } from 'react';
export function Example() {
  const [value, setValue] = useState(0);
  setValue(value + 1);
  useMemo(() => { console.log(value); }, [value]);
  return <div>{value}</div>;
}`;
  for (const file of [
    'apps/ui/sources/example.tsx',
    'packages/plugins/example/src/ui/example.tsx',
  ]) {
    await writeFile(fixture.path(file), broken);
  }
  await writeFile(
    fixture.path('defects.js'),
    'debugger; const obj = { key: 1, key: 2 }; if (typeof obj === "null") console.log(obj);',
  );
  await writeFile(fixture.path('scripts/build/authored.js'), 'debugger;');
  const result = await runNodeCapture([oxlint, '--format=json'], {
    cwd: fixture.root,
  });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const diagnostics = JSON.parse(result.stdout).diagnostics;
  for (const file of [
    'apps/ui/sources/example.tsx',
    'packages/plugins/example/src/ui/example.tsx',
  ]) {
    for (const code of ['react(set-state-in-render)', 'react(void-use-memo)']) {
      assert.ok(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.filename === file && diagnostic.code === code,
        ),
        `${file}: ${code}\n${result.stdout}`,
      );
    }
  }
  for (const code of [
    'eslint(no-debugger)',
    'eslint(no-dupe-keys)',
    'eslint(valid-typeof)',
  ]) {
    assert.ok(
      diagnostics.some((diagnostic) => diagnostic.code === code),
      code,
    );
  }
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.filename === 'scripts/build/authored.js' &&
        diagnostic.code === 'eslint(no-debugger)',
    ),
    'authored build code must be linted',
  );

  const valid = `import { useState, useMemo } from 'react';
export function Example() {
  const [value, setValue] = useState(0);
  const label = useMemo(() => value + 1, [value]);
  return <button onClick={() => setValue(value + 1)}>{label}</button>;
}`;
  for (const file of [
    'apps/ui/sources/example.tsx',
    'packages/plugins/example/src/ui/example.tsx',
  ]) {
    await writeFile(fixture.path(file), valid);
  }
  await writeFile(
    fixture.path('defects.js'),
    'const obj = { key: 1 }; if (typeof obj === "object") console.log(obj);',
  );
  await writeFile(
    fixture.path('scripts/build/authored.js'),
    'export const authored = true;',
  );
  const green = await runNodeCapture([oxlint, '--format=json'], {
    cwd: fixture.root,
  });
  assert.equal(green.code, 0, green.stdout + green.stderr);
  assert.deepEqual(JSON.parse(green.stdout).diagnostics, []);
});

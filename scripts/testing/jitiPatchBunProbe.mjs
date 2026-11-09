import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(`${process.cwd()}/apps/cli/package.json`);
const { createJiti } = require(process.argv[2] || 'jiti');
const root = await mkdtemp(join(tmpdir(), 'happier-jiti-bun-interop-'));
try {
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await mkdir(join(root, 'commonjs'));
  await writeFile(join(root, 'commonjs/package.json'), '{"type":"commonjs"}');
  await writeFile(join(root, 'commonjs/dependency.js'), '// export default is a comment\nexports.named = 7;');
  await mkdir(join(root, 'node_modules/typeless'), { recursive: true });
  await writeFile(join(root, 'node_modules/typeless/index.js'), '// export default is a comment\nexports.value = 10;');
  await writeFile(join(root, 'typed.ts'), 'export const typed: number = 9;');
  const entry = join(root, 'entry.ts');
  await writeFile(entry, `import value from './dependency.cjs';
import * as statically from './commonjs/dependency.js';
import { typed } from './typed.ts';
import implicit from './node_modules/typeless/index.js';
export async function read() {
  const js = await import('./commonjs/dependency.js');
  const cjs = await import('./dependency.cjs');
  return { js: js.default.named, cjs: cjs.default.value, typed, implicit: implicit.value,
    staticIdentity: js === statically, defaultIdentity: cjs.default === value };
}`);
  const candidates = [];
  for (const value of [8, 6]) {
    await writeFile(join(root, 'dependency.cjs'), `// export default is a comment\nmodule.exports = { value: ${value} }; Object.defineProperty(module.exports, Symbol.toStringTag, { value: "Module" });`);
    const loader = createJiti(`${process.cwd()}/apps/cli/package.json`, {
      forceTranspile: true, nodeImportInterop: true, interopDefault: false, fsCache: false,
    });
    const loaded = await loader.import(entry);
    const result = await loaded.read();
    assert.deepEqual(result, { js: 7, cjs: value, typed: 9, implicit: 10, staticIdentity: true, defaultIdentity: true });
    candidates.push(result.cjs);
    for (const file of [entry, join(root, 'dependency.cjs'), join(root, 'typed.ts'), join(root, 'commonjs/dependency.js'), join(root, 'node_modules/typeless/index.js')]) {
      delete loader.cache[loader.resolve(file)];
    }
  }
  console.log(JSON.stringify({ runtime: process.versions.bun ? `Bun ${process.versions.bun}` : process.version, interop: 'PASS', candidates }));
} finally {
  await rm(root, { recursive: true, force: true });
}

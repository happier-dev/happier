import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const bun = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['bun'], { encoding: 'utf8' }).stdout?.split(/\r?\n/u)[0]?.trim();
const pluginPath = fileURLToPath(new URL('./asciiLegalComments.mjs', import.meta.url));

it.skipIf(!bun)('the server bundle keeps legal comments but stays ASCII', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascii-legal-comments-'));
  try {
    // The dependency shape that made the shipped server bundle two-byte (undici, light-my-request).
    writeFileSync(join(dir, 'dep.js'), 'export function f() {\n  /*! formdata-polyfill. MIT License. Jimmy Wärting */\n  return "été";\n}\n');
    writeFileSync(join(dir, 'entry.js'), 'import { f } from "./dep.js";\nconsole.log(f());\n');
    writeFileSync(join(dir, 'build.mjs'), [
      `const { createAsciiLegalCommentsPlugin } = await import(${JSON.stringify(pluginPath)});`,
      `for (const plugins of [[], [createAsciiLegalCommentsPlugin()]]) {`,
      `  const result = await Bun.build({ entrypoints: [${JSON.stringify(join(dir, 'entry.js'))}], target: 'bun', plugins });`,
      `  const text = await result.outputs[0].text();`,
      `  await Bun.write(${JSON.stringify(join(dir, 'out'))} + plugins.length + '.js', text);`,
      `  console.log(JSON.stringify({ plugins: plugins.length, ascii: !/[^\\x00-\\x7f]/.test(text), legal: text.includes('W\\\\u00e4rting') || text.includes('Wärting') }));`,
      `}`,
    ].join('\n'));
    const lines = execFileSync(bun, [join(dir, 'build.mjs')], { encoding: 'utf8' }).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([{ plugins: 0, ascii: false, legal: true }, { plugins: 1, ascii: true, legal: true }]);
    // Program text is unchanged: the escaped bundle prints the same string.
    expect(execFileSync(bun, [join(dir, 'out1.js')], { encoding: 'utf8' })).toBe('été\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

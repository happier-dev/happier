import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createWorkspaceSourceResolver, readWorkspacePackages } from '../../../../cli-common/sourceRuntimeEntries.mjs';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const requireFromProject = createRequire(join(repoRoot, 'apps/cli/package.json'));
const { build } = requireFromProject('esbuild') as typeof import('esbuild');

it('parses text, HTML and attachment bytes through the daemon source-bundle resolver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-email-parser-bundle-'));
  try {
    // Source daemons borrow this installed host tree; importer-local libraries
    // must work from the emitted graph without their authored sibling files.
    const outputDir = join(root, 'runtime');
    await mkdir(outputDir);
    await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(join(repoRoot, 'apps/cli/node_modules'), join(outputDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const outfile = join(outputDir, 'parse.mjs');
    await build({ entryPoints: ['parse', 'compose'].map(name => fileURLToPath(new URL(`./${name}.ts`, import.meta.url))),
      outdir: outputDir, outExtension: { '.js': '.mjs' },
      bundle: true, splitting: true, platform: 'node', format: 'esm', conditions: ['happier-source'],
      banner: { js: 'import { createRequire as __sourceCreateRequire } from "node:module"; const require = __sourceCreateRequire(import.meta.url);' },
      plugins: [createWorkspaceSourceResolver({ workspacePackages: await readWorkspacePackages(repoRoot), requireFromProject })],
      logLevel: 'silent' });
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const { parseEmail } = await import(pathToFileURL(process.argv[1]).href);
      const plain = await parseEmail(Buffer.from('From: sender@example.com\\r\\nSubject: Hello\\r\\n\\r\\nBody'));
      assert.equal(plain.subject, 'Hello'); assert.equal(plain.text, 'Body');
      const mime = [
        'From: sender@example.com', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=fixture', '',
        '--fixture', 'Content-Type: text/html; charset=utf-8', '',
        '<style>.hidden {display:none}</style><p>Hello HTML</p><p class="hidden">hidden content</p>',
        '--fixture', 'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename=bytes.bin',
        'Content-Transfer-Encoding: base64', '', 'AP+A', '--fixture--', '',
      ].join('\\r\\n');
      const html = await parseEmail(Buffer.from(mime));
      assert.match(html.text, /Hello HTML/); assert.doesNotMatch(html.text, /hidden content/);
      assert.deepEqual([...html.attachments[0].bytes], [0, 255, 128]);
      const { composeEmail } = await import(new URL('./compose.mjs', pathToFileURL(process.argv[1])));
      const composed = await composeEmail({ mailbox: 'sender@example.com', recipients: ['recipient@example.com'],
        deliveryKey: 'compiled-fixture', subject: 'Composed', content: { text: '**Hello**' } });
      assert.equal((await parseEmail(composed.mime)).subject, 'Composed');
      console.log('compiled Email parser: text, HTML, binary attachment passed');
    `, outfile], { env: { ...process.env, NODE_PATH: '' } });
    expect(stdout).toContain('compiled Email parser: text, HTML, binary attachment passed');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

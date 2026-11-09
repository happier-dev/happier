import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { createJiti } from 'jiti';
import { describe, expect, it } from 'vitest';

import {
    createPluginTypeScriptCandidateScope,
    createPluginTypeScriptGenerationScope,
    loadPluginAuthorSourceModule,
    loadVerifiedPluginModule,
} from './loadPluginModule';

const execute = promisify(execFile);
const bunCommand = process.env.HAPPIER_BUN_PATH || 'bun';
const hasBun = spawnSync(bunCommand, ['--version'], { encoding: 'utf8' }).status === 0;
const cases = [
    ['class', 'cjs', 'module.exports = class Mailbox {}; module.exports.marker = "mailbox"; Object.assign(module.exports, { runtimeOnly: true });'],
    ['named', 'cjs', '// export default is only a CommonJS comment\nexports.named = { value: 7 };'],
    ['reexport', 'cjs', 'module.exports = require("./named.cjs");'],
    ['esModule', 'cjs', 'Object.defineProperty(exports, "__esModule", { value: true }); exports.default = { inner: true }; exports.named = 7;'],
    ['namespaceTag', 'cjs', 'Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" }); exports.named = { value: 11 };'],
    ['json5', 'cjs', 'module.exports = { parse: text => JSON.parse(text), stringify: JSON.stringify };'],
    ['esm', 'mjs', 'export default { value: 7 }; export const named = { value: 9 };'],
] as const;

function entrySource(extension: string) {
    return 'import { createRequire } from "node:module"; const nativeRequire = createRequire(import.meta.url);\n'
        + cases.map(([name, kind]) => `import ${name}Default, * as ${name}Static from "./${name}.${kind}";`).join('\n') + `
export async function read() {
  const result = {};
  ${cases.map(([name, kind]) => `{
    const first = await import("./${name}.${kind}");
    const second = await import("./${name}.${kind}");
    result.${name} = {
      keys: Object.keys(first).sort(), defaultType: typeof first.default,
      sameDefault: first.default === ${name}Default,
      sameNamespace: first === second, sameStatic: first === ${name}Static,
      namedIdentity: first.named === ${name}Static.named,
      ${kind === 'cjs' ? `sameRequire: first.default === nativeRequire("./${name}.${kind}"),` : ''}
      defaultKeys: Object.keys(first.default).sort(),
      ...(first.default.parse ? { parsed: first.default.parse('{"connected":true}') } : {}),
    };
  }`).join('\n')}
  return result;
}
${extension === 'mjs' ? 'read().then(result => console.log(JSON.stringify(result)));' : ''}
`;
}

describe('plugin imports match native Node', () => {
    it('preserves inline CommonJS evaluation with a virtual filename when import interop is disabled', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-inline-jiti-'));
        const filename = join(root, 'virtual.js');
        const loader = createJiti(import.meta.url, { interopDefault: false, fsCache: false });
        try {
            expect(loader.evalModule('module.exports = { value: 7 };', { filename })).toEqual({ value: 7 });
        } finally {
            delete loader.cache[filename];
            await rm(root, { recursive: true, force: true });
        }
    });

    it.skipIf(!hasBun)('preserves forced CJS and TS imports in Bun source and compiled payloads', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-bun-import-parity-'));
        const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
        const probe = join(repoRoot, 'scripts/testing/jitiPatchBunProbe.mjs');
        const jitiEntry = createRequire(new URL('../../../package.json', import.meta.url)).resolve('jiti');
        const output = join(root, process.platform === 'win32' ? 'probe.exe' : 'probe');
        try {
            const node = await execute(process.execPath, [probe, jitiEntry], { cwd: repoRoot });
            expect(JSON.parse(node.stdout)).toMatchObject({ interop: 'PASS', candidates: [8, 6] });
            const source = await execute(bunCommand, [probe, jitiEntry], { cwd: repoRoot });
            expect(JSON.parse(source.stdout)).toMatchObject({ interop: 'PASS', candidates: [8, 6] });
            await execute(bunCommand, ['build', probe, '--compile', '--external', 'jiti', '--outfile', output], { cwd: repoRoot });
            const compiled = await execute(output, [jitiEntry], { cwd: repoRoot });
            expect(JSON.parse(compiled.stdout)).toMatchObject({ interop: 'PASS', candidates: [8, 6] });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it.each([
        ['commonjs', '// export default is a comment\nexports.named = 7;'],
        ['commonjs', 'exports.named = "export default in a string";'],
        ['commonjs', 'exports.named = `export default in a template`;'],
        ['commonjs', 'exports.named = `\nexport default in a multiline template\n`;'],
        ['typeless', '/* export default is a comment */\nexports.named = 7;'],
        ['typeless', 'exports.named = /export default/;'],
        ['typeless', 'export const named = 7;'],
        ['typeless', 'await Promise.resolve(); export const named = 7;'],
        ['typeless', 'await Promise.resolve(); globalThis.formatProbeEvaluations = (globalThis.formatProbeEvaluations ?? 0) + 1;'],
        ['typeless', 'const url = import.meta.url; export { url };'],
        ['typeless', 'globalThis.formatProbeEvaluations = import.meta.url ? 1 : 0;'],
        ['module', 'globalThis.formatProbeEvaluations = (globalThis.formatProbeEvaluations ?? 0) + 1;'],
    ])('matches Node for nested %s .js format: %s', async (packageType, dependencySource) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-format-parity-'));
        try {
            // The nearest package boundary must win over the module parent.
            await writeFile(join(root, 'package.json'), '{"type":"module"}');
            await mkdir(join(root, 'nested'));
            await writeFile(join(root, 'nested/package.json'), packageType === 'typeless' ? '{}' : JSON.stringify({ type: packageType }));
            await writeFile(join(root, 'nested/dependency.js'), dependencySource);
            const source = 'import * as statically from "./nested/dependency.js"; export async function read() { const first = await import("./nested/dependency.js"); const second = await import("./nested/dependency.js"); return { names: Object.keys(first).sort(), staticIdentity: first === statically, cachedIdentity: first === second, defaultIdentity: first.default === statically.default, named: String(first.named ?? ""), evaluations: globalThis.formatProbeEvaluations ?? 0 }; }';
            const oracle = join(root, 'oracle.mjs');
            await writeFile(oracle, source + '\nread().then(value => console.log(JSON.stringify(value)));');
            const expected: unknown = JSON.parse((await execute(process.execPath, [oracle])).stdout);
            const entryPath = join(root, 'plugin.ts');
            await writeFile(entryPath, source);
            const loaded = await loadVerifiedPluginModule({ entryPath, loadMode: 'source-ts',
                generationScope: await createPluginTypeScriptCandidateScope({ rootPath: root }) });
            if (typeof loaded.read !== 'function') throw new Error('Missing format fixture entry');
            expect(await loaded.read()).toEqual(expected);
            expect(await loaded.read()).toEqual(expected);
        } finally {
            delete (globalThis as typeof globalThis & { formatProbeEvaluations?: number }).formatProbeEvaluations;
            await rm(root, { recursive: true, force: true });
        }
    });

    it('uses the actual CommonJS grammar when a .js dependency contains export text', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-cjs-grammar-'));
        try {
            await writeFile(join(root, 'package.json'), '{"type":"commonjs"}');
            await writeFile(join(root, 'dependency.js'), '// export default is a comment\nexports.named = 7;');
            const source = 'import value, * as namespace from "./dependency.js"; export async function read() { const dynamic = await import("./dependency.js"); return { keys: Object.keys(dynamic).sort(), same: dynamic.default === value, sameNamespace: dynamic === namespace }; }';
            const oracle = join(root, 'oracle.mjs');
            await writeFile(oracle, source + '\nread().then(value => console.log(JSON.stringify(value)));');
            const expected = await execute(process.execPath, [oracle]);
            const entryPath = join(root, 'plugin.ts');
            await writeFile(entryPath, source);
            const loaded = await loadVerifiedPluginModule({ entryPath, loadMode: 'source-ts',
                generationScope: await createPluginTypeScriptCandidateScope({ rootPath: root }) });
            if (typeof loaded.read !== 'function') throw new Error('Missing grammar fixture entry');
            expect(await loaded.read()).toEqual(JSON.parse(expected.stdout));
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('executes the Email and JSON5 lazy import expressions in a fully bundled CommonJS payload', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-bundled-cjs-'));
        const emailRequire = createRequire(new URL('../../../../../packages/plugins/channel-email/package.json', import.meta.url));
        const devcontainerRequire = createRequire(new URL('../../../../../packages/plugins/devcontainer/package.json', import.meta.url));
        const specifier = (id: string) => JSON.stringify(emailRequire.resolve(id));
        try {
            const source = `
async function read() {
  const [{ default: SmtpClient }, { default: XOAuth2 }] = await Promise.all([
    import(${specifier('nodemailer/lib/smtp-connection/index.js')}),
    import(${specifier('nodemailer/lib/xoauth2/index.js')}),
  ]);
  const smtp = new SmtpClient({});
  const oauth = new XOAuth2({ user: 'sender@example.com', accessToken: 'fixture' });
  const nodemailer = await import(${specifier('nodemailer')});
  const { createTransport } = { ...nodemailer.default, ...nodemailer };
  const message = await createTransport({ streamTransport: true, buffer: true }).sendMail({
    from: 'sender@example.com', to: 'recipient@example.com', subject: 'Parity', text: 'Connected',
  });
  const mailparser = await import(${specifier('mailparser')});
  const { simpleParser } = { ...mailparser.default, ...mailparser };
  const parsed = await simpleParser(message.message);
  const configuration = (await import(${JSON.stringify(devcontainerRequire.resolve('json5'))})).default.parse('{connected:true}');
  return { smtp: typeof smtp.connect, oauth: typeof oauth.getToken,
    subject: parsed.subject, text: parsed.text.trim(), configuration };
}
read().then(result => console.log(JSON.stringify(result)));
`;
            const oracle = join(root, 'native.mjs');
            await writeFile(oracle, source);
            const expected = await execute(process.execPath, [oracle]);
            const bundle = join(root, 'bundled.cjs');
            await build({ entryPoints: [oracle], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
            const actual = await execute(process.execPath, [bundle]);
            expect(JSON.parse(actual.stdout)).toEqual(JSON.parse(expected.stdout));
            expect(JSON.parse(actual.stdout)).toEqual({ smtp: 'function', oauth: 'function', subject: 'Parity', text: 'Connected', configuration: { connected: true } });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('preserves static and dynamic defaults in mutable JavaScript author modules', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-js-import-parity-'));
        try {
            await writeFile(join(root, 'package.json'), '{"type":"module"}');
            for (const [name, extension, source] of cases) {
                await writeFile(join(root, `${name}.${extension}`), source);
            }
            const oracle = join(root, 'oracle.mjs');
            await writeFile(oracle, entrySource('mjs'));
            const { stdout } = await execute(process.execPath, [oracle]);
            for (const extension of ['js', 'mjs']) {
                const entry = join(root, `plugin.${extension}`);
                await writeFile(entry, entrySource('ts'));
                const loaded = await loadPluginAuthorSourceModule(entry);
                if (typeof loaded.read !== 'function') throw new Error('Missing JS parity fixture entry');
                expect(await loaded.read()).toEqual(JSON.parse(stdout));
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('retires a forced CommonJS namespace with its candidate after an edit', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-cjs-reload-'));
        try {
            const dependency = join(root, 'dependency.cjs');
            const entryPath = join(root, 'plugin.ts');
            await writeFile(entryPath, 'import value from "./dependency.cjs"; export async function read() { const dynamic = await import("./dependency.cjs"); return { value: dynamic.default.value, same: dynamic.default === value }; }');
            for (const value of [1, 2]) {
                await writeFile(dependency, `module.exports = { value: ${value} };`);
                const loaded = await loadVerifiedPluginModule({ entryPath, loadMode: 'source-ts',
                    generationScope: await createPluginTypeScriptCandidateScope({ rootPath: root }) });
                if (typeof loaded.read !== 'function') throw new Error('Missing reload fixture entry');
                expect(await loaded.read()).toEqual({ value, same: true });
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it.each(['author', 'generation', 'candidate', 'compiled'] as const)('%s preserves CommonJS/ESM namespaces and static/dynamic identity on cold and cached reads', async (kind) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-import-parity-'));
        try {
            for (const [name, extension, source] of cases) {
                await writeFile(join(root, `${name}.${extension}`), source);
            }
            const oracle = join(root, 'oracle.mjs');
            await writeFile(oracle, entrySource('mjs'));
            const { stdout } = await execute(process.execPath, [oracle]);
            const expected: unknown = JSON.parse(stdout);
            const entryPath = join(root, 'plugin.ts');
            await writeFile(entryPath, entrySource('ts'));
            if (kind === 'compiled') {
                const bundle = join(root, 'plugin.mjs');
                // Compiled ESM uses Node's import semantics. Fully bundled call-site
                // behavior is checked separately; esbuild's synthetic namespaces
                // do not promise Node's namespace keys or namespace identity.
                await build({ entryPoints: [oracle], outfile: bundle, bundle: false, platform: 'node', format: 'esm', target: 'node22' });
                const actual = await execute(process.execPath, [bundle]);
                expect(JSON.parse(actual.stdout)).toEqual(expected);
                return;
            }
            const loaded = kind === 'author'
                ? await loadPluginAuthorSourceModule(entryPath)
                : await loadVerifiedPluginModule({ entryPath, loadMode: 'source-ts', generationScope: kind === 'candidate'
                    ? await createPluginTypeScriptCandidateScope({ rootPath: root })
                    : createPluginTypeScriptGenerationScope() });
            if (typeof loaded.read !== 'function') throw new Error('Missing parity fixture entry');
            expect(await loaded.read()).toEqual(expected);
            expect(await loaded.read()).toEqual(expected);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

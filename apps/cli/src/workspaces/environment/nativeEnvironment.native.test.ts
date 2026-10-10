import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectNativeIo } from '../projectSetup/projectNativeIo';
import { produceProjectNativeEnvironment } from './produceProjectNativeEnvironment';

// Explicit installed-binary opt-in, like B3_NATIVE_MISE_PATH. These tests do
// not install tools, qualify another OS, or substitute a native CLI fixture.
const installed = [
    { tool: 'devbox', binary: process.env.FX15_NATIVE_DEVBOX_PATH, version: '0.18.4', config: 'devbox.json' },
    { tool: 'devenv', binary: process.env.FX15_NATIVE_DEVENV_PATH, version: '2.4.0', config: 'devenv.nix' },
    { tool: 'flox', binary: process.env.FX15_NATIVE_FLOX_PATH, version: '1.18.1-gf264cf2', config: '.flox/env/manifest.toml' },
    { tool: 'nix_flake', binary: process.env.FX15_NATIVE_NIX_PATH, version: '2.35.2', config: 'flake.nix' },
] as const;
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
type Installed = typeof installed[number];
type Fixture = Awaited<ReturnType<typeof fixture>>;
const nixpkgs = 'github:NixOS/nixpkgs/8edc0c72e3a38faf5434e40d1f19431125fe4b30';

function run(binary: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
    return new Promise<string>((resolve, reject) => {
        // Native stdout stays inside the fixture; never dump inherited values.
        execFile(binary, [...args], { cwd, env }, (error, stdout, stderr) => {
            if (error) reject(new Error(`Native fixture failed (${error.code}): ${stderr}`));
            else resolve(stdout);
        });
    });
}
async function fixture(native: Installed, hook = 'export FX15_HOOK=activated; unset FX15_REMOVE') {
    if (!native.binary) throw new Error('Installed native binary required');
    const root = await mkdtemp(join(tmpdir(), `happier-fx15-${native.tool}-`));
    roots.push(root);
    const cwd = join(root, "nested cwd with spaces $literal `literal` 'quoted'");
    await mkdir(cwd);
    const env: NodeJS.ProcessEnv = { ...process.env, DEVBOX_USE_VERSION: '0.18.4', FLOX_DISABLE_METRICS: 'true',
        NIX_CONFIG: `${process.env.NIX_CONFIG ?? ''}\nexperimental-features = nix-command flakes\n`,
        FX15_KEEP: 'inherited', FX15_REMOVE: 'remove', FX15_LITERAL: 'value=with\nnewline' };
    if (native.tool === 'devbox') await writeFile(join(root, native.config), JSON.stringify({ packages: [],
        env: { FX15_NATIVE: 'selected' }, shell: { init_hook: [hook] } }));
    if (native.tool === 'devenv') {
        await writeFile(join(root, 'devenv.yaml'), `inputs:\n  nixpkgs:\n    url: ${nixpkgs}\n`);
        await writeFile(join(root, native.config), `{ ... }: { env.FX15_NATIVE = "selected"; enterShell = ''${hook}''; }`);
    }
    if (native.tool === 'flox') {
        await run(native.binary, ['init', '--dir', root, '--name', 'fx15', '--bare', '--no-auto-setup'], root, env);
        await writeFile(join(root, native.config), `version = 1\n[vars]\nFX15_NATIVE = "selected"\n[hook]\non-activate = '''${hook}'''\n[profile]\ncommon = '''export FX15_PROFILE=activated; unset FX15_PROFILE_REMOVE'''\n[options]\nsystems = ["x86_64-linux"]\n`);
    }
    if (native.tool === 'nix_flake') await writeFile(join(root, native.config), `{
        inputs.nixpkgs.url = "${nixpkgs}";
        outputs = { nixpkgs, ... }: { devShells.x86_64-linux.default = nixpkgs.legacyPackages.x86_64-linux.mkShell {
            FX15_NATIVE = "selected"; shellHook = ''${hook}'';
        }; };
    }`);
    return { root, cwd, env };
}
function activation(native: Installed, root: string, command: readonly string[]) {
    switch (native.tool) {
        case 'devbox': return ['run', '--config', root, '--', ...command];
        case 'devenv': return ['--from', `path:${root}`, 'shell', '--', ...command];
        case 'flox': return ['activate', '--dir', root, '-c', command.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')];
        case 'nix_flake': return ['--extra-experimental-features', 'nix-command flakes', 'develop', `path:${root}`, '--command', ...command];
    }
}
async function produce(native: Installed, f: Fixture, signal?: AbortSignal) {
    return produceProjectNativeEnvironment({ selection: { kind: 'toolchain', tool: native.tool, configPath: native.config },
        root: f.root, cwd: f.cwd, env: Object.fromEntries(Object.entries(f.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        platform: process.platform, io: createProjectNativeIo().environmentIo, signal });
}

for (const native of installed) describe.skipIf(!native.binary)(`${native.tool} installed Linux contract`, () => {
    beforeEach(() => {
        if (native.binary) vi.stubEnv('PATH', [dirname(native.binary), process.env.PATH ?? ''].join(delimiter));
    });
    it('characterizes native version, export format and complete activation with removals', async () => {
        const f = await fixture(native);
        const version = await run(native.binary!, native.tool === 'devbox' ? ['version'] : ['--version'], f.cwd, f.env);
        expect(version.trim()).toContain(native.version);
        const stdout = await run(native.binary!, activation(native, f.root, ['/usr/bin/env', '-0']), f.cwd, f.env);
        const entries = Object.fromEntries(stdout.slice(0, -1).split('\0').map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
        expect(stdout.endsWith('\0')).toBe(true);
        expect(entries).toMatchObject({ FX15_NATIVE: 'selected', FX15_HOOK: 'activated', FX15_KEEP: 'inherited', FX15_LITERAL: 'value=with\nnewline' });
        expect(entries).not.toHaveProperty('FX15_REMOVE');
        if (native.tool === 'flox') {
            expect(entries.FX15_PROFILE).toBe('activated');
            const exported = await run(native.binary!, ['activate', '--dir', f.root], f.cwd, { ...f.env, FLOX_SHELL: '/bin/bash' });
            expect(exported).toContain('export ');
            expect(exported).not.toContain('FX15_PROFILE=activated');
        }
        if (native.tool === 'devbox') {
            const exported = await run(native.binary!, ['shellenv', '--config', f.root], f.cwd, f.env);
            expect(exported).toContain('export ');
            expect(exported).not.toContain('FX15_HOOK');
        } else if (native.tool === 'devenv' || native.tool === 'nix_flake') {
            const args = native.tool === 'devenv' ? ['--from', `path:${f.root}`, 'print-dev-env', '--json']
                : ['--extra-experimental-features', 'nix-command flakes', 'print-dev-env', `path:${f.root}`, '--json'];
            const exported = JSON.parse(await run(native.binary!, args, f.cwd, f.env));
            expect(exported.variables.FX15_NATIVE).toEqual({ type: 'exported', value: 'selected' });
            expect(exported.variables).not.toHaveProperty('FX15_HOOK');
        }
    }, 600_000);

    it('produces through admitted installed version IO without a Project and preserves complete environment semantics', async () => {
        const f = await fixture(native, 'printf "native hook diagnostic\\n"; export FX15_HOOK=activated; unset FX15_REMOVE');
        f.env.FX15_PROFILE_REMOVE = 'remove';
        expect(await createProjectNativeIo().environmentIo.resolveTool(native.tool))
            .toMatchObject({ executablePath: native.binary, version: native.version });
        const result = await produce(native, f);
        expect(result).toMatchObject({ status: 'ready', env: { FX15_NATIVE: 'selected', FX15_HOOK: 'activated', FX15_KEEP: 'inherited', FX15_LITERAL: 'value=with\nnewline' } });
        if (result.status !== 'ready') throw new Error(result.code);
        expect(result.env).not.toHaveProperty('FX15_REMOVE');
        expect(result.env.PWD).toBe(f.cwd);
        if (native.tool === 'flox') {
            expect(result.env.FX15_PROFILE).toBe('activated');
            expect(result.env).not.toHaveProperty('FX15_PROFILE_REMOVE');
        }
    }, 600_000);

    it('refuses missing and invalid selected configuration, then permits repair', async () => {
        const f = await fixture(native);
        const valid = await readFile(join(f.root, native.config), 'utf8');
        await writeFile(join(f.root, native.config), 'not valid config ] }');
        expect(await produce(native, f)).toMatchObject({ status: 'refused', kind: 'native_failed' });
        await writeFile(join(f.root, native.config), valid);
        expect(await produce(native, f)).toMatchObject({ status: 'ready' });
        await rm(join(f.root, native.config));
        expect(await produce(native, f)).toMatchObject({ status: 'refused', kind: 'unavailable', code: 'native_configuration_unavailable' });
    }, 600_000);

    it.skipIf(native.tool !== 'flox')('produces environment without starting independently owned Flox services', async () => {
        const f = await fixture(native);
        const manifest = join(f.root, native.config);
        await writeFile(manifest, `${(await readFile(manifest, 'utf8')).replace('version = 1', 'schema-version = "1.12.0"')}\n[services]\nauto-start = true\n[services.fx15]\ncommand = '''printf observed > "$FLOX_ENV_PROJECT/service-started"'''\n`);
        // Validate this installed manifest/activation contract before testing
        // the host producer; fixture/schema failures are not meaningful RED.
        await run(native.binary!, ['activate', '--dir', f.root, '--no-start-services', '-c', '/usr/bin/env -0'], f.cwd, { ...f.env, FLOX_SHELL: '/bin/bash' });
        const result = await produce(native, f);
        expect(result).toMatchObject({ status: 'ready', env: { FLOX_ACTIVATE_START_SERVICES: 'false' } });
        await expect(readFile(join(f.root, 'service-started'))).rejects.toMatchObject({ code: 'ENOENT' });
    }, 600_000);

    it('cancels an actual evaluator child through incumbent custody and permits fresh production', async () => {
        const f = await fixture(native, 'echo $$ > "$FX15_PID_FILE"; while :; do sleep 1; done');
        const pidFile = join(f.root, 'native.pid');
        const controller = new AbortController();
        const ready = new Promise<string>((resolve, reject) => {
            const observer = watch(f.root, () => { void readFile(pidFile, 'utf8').then(value => {
                if (/^\d+\s*$/.test(value)) { observer.close(); resolve(value); }
            }).catch(() => {}); });
            observer.on('error', reject);
            controller.signal.addEventListener('abort', () => observer.close(), { once: true });
        });
        f.env = { ...f.env, FX15_PID_FILE: pidFile };
        const running = produce(native, f, controller.signal);
        try {
            const pid = Number(await Promise.race([ready, running.then(() => { throw new Error('Native producer settled before evaluator readiness'); })]));
            controller.abort();
            expect(await running).toMatchObject({ status: 'refused', kind: 'cancelled' });
            expect(() => process.kill(pid, 0)).toThrow();
        } finally { controller.abort(); await running; }
        const repaired = await fixture(native);
        expect(await produce(native, repaired)).toMatchObject({ status: 'ready' });
    }, 600_000);
});

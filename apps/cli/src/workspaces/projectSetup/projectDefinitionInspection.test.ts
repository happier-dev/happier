import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverLocalServiceRunTargets } from '@/daemon/local/services/launch/runTargets';
import { inspectProjectDefinitions } from './projectDefinitionInspection';
import { resolveNativePackageManager } from './nativePackageScripts';

const roots: string[] = [];
async function fixture(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-inspection-'));
    roots.push(root);
    for (const [file, bytes] of Object.entries(files)) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), bytes);
    }
    return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('inspectProjectDefinitions', () => {
    it.each(['npm', 'yarn', 'pnpm', 'bun'] as const)('shares %s declaration, version and root with Services without copying bodies', async (manager) => {
        const root = await fixture({
            'package.json': JSON.stringify({ name: 'root', packageManager: `${manager}@1.2.3` }),
            'web/package.json': JSON.stringify({ name: 'web', scripts: { dev: 'touch should-never-exist', build: 'false' } }),
        });
        const before = await readFile(join(root, 'web/package.json'), 'utf8');
        const detection = await inspectProjectDefinitions(root);
        expect(detection.entries).toContainEqual({ source: { kind: 'native', tool: 'package_script', file: 'web/package.json', target: 'dev' }, usage: 'script' });
        expect(detection.entries.every((entry) => !('command' in entry.source))).toBe(true);
        expect(await resolveNativePackageManager(join(root, 'web'))).toEqual({ manager, version: '1.2.3', root });
        expect((await discoverLocalServiceRunTargets({ roots: [root] }))[0]?.packageManager).toBe(manager);
        expect(await readFile(join(root, 'web/package.json'), 'utf8')).toBe(before);
        expect((await readdir(root)).sort()).toEqual(['package.json', 'web']);
    });

    it('detects every native command dialect, distinguishing Services and environment-only sources passively', async () => {
        const root = await fixture({
            'mise.toml': '[tools]\nnode="22"\n[tasks.build]\nrun="touch forbidden"\n',
            'Makefile': 'build: input\n\ttouch forbidden\ninclude $(computed)\n',
            'justfile': 'build:\n    touch forbidden\n',
            'Taskfile.yml': 'version: "3"\ntasks:\n  build:\n    cmds: [touch forbidden]\nincludes:\n  dynamic: "{{.TASKFILE}}"\n',
            'turbo.json': '{"tasks":{"build":{"dependsOn":["^build"]}}}',
            'compose.yaml': 'services:\n  web:\n    image: nginx\n',
            'Procfile': 'web: touch forbidden\n',
            'devbox.json': '{"packages":["nodejs"],"shell":{"scripts":{"build":"touch forbidden"}}}',
            'devenv.nix': '{ pkgs, ... }: { scripts.build.exec = "touch forbidden"; scripts = builtins.getAttr "dynamic" {}; }',
            '.flox/env/manifest.toml': 'version=1\n[services.web]\ncommand="touch forbidden"\n[build.build]\ncommand="touch forbidden"\n[include]\nenvironments=[{remote="user/dynamic"}]\n[hook]\non-activate="touch forbidden"\n',
            'flake.nix': '{ outputs = inputs: { devShells.default = {}; }; }',
            '.devcontainer/devcontainer.json': '{\n// contained JSONC configuration\n"image":"ubuntu",\n}',
        });
        const detection = await inspectProjectDefinitions(root);
        const entries = detection.entries.map(({ source, usage }) => `${source.kind === 'native' ? source.tool : 'plugin'}:${source.target}:${usage}`);
        for (const tool of ['mise', 'make', 'just', 'taskfile', 'turbo', 'devbox', 'devenv', 'flox']) expect(entries).toContain(`${tool}:build:script`);
        expect(entries).toContain('flox:web:service');
        expect(entries).toContain('compose:web:service');
        expect(entries).toContain('procfile:web:service');
        expect(entries.some((entry) => entry.startsWith('nix'))).toBe(false);
        expect(detection.environments.map((environment) => environment.kind === 'toolchain' ? environment.tool : environment.kind)).toEqual(expect.arrayContaining(['mise', 'devbox', 'devenv', 'flox', 'nix_flake']));
        expect(detection.devcontainers).toEqual([{ configPath: '.devcontainer/devcontainer.json' }]);
        expect(detection.coverage).toBe('partial');
        expect(detection.diagnostics.map((diagnostic) => diagnostic.file)).toEqual(expect.arrayContaining(['Makefile', 'Taskfile.yml', 'devenv.nix', 'flake.nix']));
        expect(await readdir(root)).not.toContain('forbidden');
    });

    it('retains good entries when malformed, unreadable and escaped native sources are encountered', async () => {
        const outside = await fixture({ 'secret.json': '{"image":"private"}' });
        const root = await fixture({ 'package.json': '{"scripts":{"build":"echo ok"}}', 'turbo.json': '{bad json' });
        await mkdir(join(root, 'compose.yaml'));
        await mkdir(join(root, '.devcontainer'));
        await symlink(join(outside, 'secret.json'), join(root, '.devcontainer/devcontainer.json'));
        const detection = await inspectProjectDefinitions(root);
        expect(detection.entries).toContainEqual({ source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'build' }, usage: 'script' });
        expect(detection.devcontainers).toEqual([]);
        expect(detection.coverage).toBe('partial');
        expect(detection.diagnostics).toEqual(expect.arrayContaining([
            { file: 'turbo.json', code: 'invalid_definition' },
            { file: 'compose.yaml', code: 'unreadable_definition' },
            { file: '.devcontainer/devcontainer.json', code: 'outside_root' },
        ]));
    });

    it('finds literal devenv script attribute sets and ignores comments and command text', async () => {
        const root = await fixture({ 'devenv.nix': '{ ... }: {\n# scripts.comment.exec = "false";\nscripts = { nested.exec = "echo ok"; object = { exec = "echo ok"; }; };\nscripts.direct.exec = "scripts.fake.exec = false;";\n}' });
        const detection = await inspectProjectDefinitions(root);
        expect(detection.entries.map((entry) => entry.source.target).sort()).toEqual(['direct', 'nested', 'object']);
        expect(detection.diagnostics).toContainEqual({ file: 'devenv.nix', code: 'unevaluated_nix' });
    });
});

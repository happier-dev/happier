import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverLocalServiceRunTargets } from '@/daemon/local/services/launch/runTargets';
import { inspectProjectDefinitions, inspectProjectDefinitionExecutionFacts, inspectProjectToolFacts, inspectProjectDefinitionFiles } from './projectDefinitionInspection';
import { resolveNativePackageManager } from './nativePackageScripts';
import { ProjectDefinitionDetectionV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { selectProjectDefinitionRead } from './projectDefinitionRead';

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
    it('reports only observed root container files, distinguishing absence from a refused file', async () => {
        const root = await fixture({ Dockerfile: 'FROM scratch', 'nested/compose.yaml': 'services: {}' });
        const detected = await inspectProjectDefinitions(root);
        expect(detected.observedAtMs).toEqual(expect.any(Number));
        expect(detected).toMatchObject({ rootFiles: { dockerfile: 'present', compose: 'absent' } });
        expect(await inspectProjectDefinitionFiles(root, [{ file: 'compose.yaml' }])).toMatchObject({ rootFiles: { dockerfile: 'unknown', compose: 'unknown' } });
        const read = selectProjectDefinitionRead({ basis: { kind: 'absent' }, document: null }, detected, { kind: 'applications' });
        expect(ProjectDefinitionDetectionV1Schema.parse(read.detection)).toMatchObject({ rootFiles: { dockerfile: 'present', compose: 'absent' } });
        const outside = await fixture({ 'compose.yaml': 'services: {}' });
        await symlink(join(outside, 'compose.yaml'), join(root, 'compose.yaml'));
        expect(await inspectProjectDefinitions(root)).toMatchObject({ rootFiles: { dockerfile: 'present', compose: 'unknown' }, coverage: 'partial' });
    });
    it('carries recognized app declarations without resolving commands, returning script rows or guessing ports', async () => {
        const root = await fixture({ 'package.json': JSON.stringify({ dependencies: { next: '15', react: '19' },
            engines: { node: '>=20' }, scripts: { build: 'next build', start: 'TOKEN=never-project next start --port 4321' } }),
            'worker/package.json': JSON.stringify({ scripts: { start: 'PORT=${PORT} node worker.js' } }),
        });
        const detection = await inspectProjectDefinitions(root);
        const read = selectProjectDefinitionRead({ basis: { kind: 'absent' }, document: null }, detection, { kind: 'applications' });
        const projected = ProjectDefinitionDetectionV1Schema.parse(read.detection);
        expect(projected).toMatchObject({ applications: [
            { file: 'package.json', framework: 'next', runtime: { name: 'node', version: '>=20' },
                build: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'build' },
                start: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'start' }, port: 4321 },
            { file: 'worker/package.json', framework: null, runtime: null, build: null,
                start: { kind: 'native', tool: 'package_script', file: 'worker/package.json', target: 'start' }, port: null },
        ] });
        expect(JSON.stringify(projected)).not.toContain('never-project');
        expect(read.candidateEntries).toEqual([]);
        expect(read.entries).toEqual([]);
        expect(read.includeSetup).toBe(false);
        expect(read.includeInvocation).toBe(false);
    });
    it('reads execution facts per source and installed selection rather than per target, retaining fresh hashes and availability', async () => {
        const scripts = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`check${index}`, 'echo initial']));
        const manifest = { version: 1 as const, scripts: Object.fromEntries(Object.keys(scripts).map(name => [name, {
            source: { kind: 'native' as const, tool: 'package_script' as const, file: 'package.json', target: name },
        }])) };
        const root = await fixture({ 'package.json': JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts }),
            ...Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`packages/p${index}/package.json`,
                JSON.stringify({ scripts: { [`workspace${index}`]: 'echo child' } })])),
        });
        const detection = await inspectProjectDefinitions(root);
        const reads = vi.spyOn(filesystem, 'readFile');
        const probes: string[] = [];
        let installed = true;
        const io = { async resolveTool(tool: string, request: Readonly<{ cwd: string; version?: string }>) {
            probes.push(JSON.stringify([tool, request.cwd, request.version ?? null]));
            return installed ? { executablePath: '/installed/pnpm', version: '10.0.0' } : null;
        } };
        try {
            const facts = await inspectProjectDefinitionExecutionFacts({ root, detection, manifest, io });
            expect(facts.importCandidates).toHaveLength(192);
            expect(facts.commands).toHaveLength(128);
            expect(facts.importCandidates.every(candidate => candidate.availability === 'available' && candidate.preselected)).toBe(true);
            expect(facts.commands.every(command => command.availability === 'available')).toBe(true);
            expect(probes).toHaveLength(66); // 65 versioned cwd selections plus the distinct unversioned host-tool fact.
            expect(reads.mock.calls.filter(([path]) => path === join(root, 'package.json')).length).toBeLessThanOrEqual(2);
            const previousHash = facts.importCandidates[0]?.executionInputs?.[0]?.hash;
            expect(previousHash).toBeTruthy();
            await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts: { ...scripts, check0: 'echo changed' } }));
            installed = false;
            probes.length = 0;
            reads.mockClear();
            const next = await inspectProjectDefinitionExecutionFacts({ root, detection, manifest, io });
            expect(next.importCandidates.every(candidate => candidate.availability === 'unavailable' && !candidate.preselected)).toBe(true);
            expect(next.commands.every(command => command.availability === 'unavailable')).toBe(true);
            expect(next.importCandidates[0]?.executionInputs?.[0]?.hash).not.toBe(previousHash);
            expect(probes).toHaveLength(66);
            expect(reads.mock.calls.filter(([path]) => path === join(root, 'package.json')).length).toBeLessThanOrEqual(2);
        } finally { reads.mockRestore(); }
    });

    it('discovers packages from directory entries without a stat per unrelated directory and reads changes on the next inspection', async () => {
        const root = await fixture({});
        await Promise.all(Array.from({ length: 1024 }, async (_, index) => {
            const directory = join(root, 'sources', `p${index}`);
            await mkdir(directory, { recursive: true });
            if (index % 16 === 0) await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { [`check${index}`]: 'echo initial' } }));
        }));
        // Observe the real filesystem boundary; discovery and all parsers stay real.
        const stats = vi.spyOn(filesystem, 'stat');
        try {
            const detection = await inspectProjectDefinitions(root);
            expect(detection.entries).toHaveLength(64);
            expect(detection.entries).toContainEqual({ source: { kind: 'native', tool: 'package_script', file: 'sources/p0/package.json', target: 'check0' }, usage: 'script' });
            expect(stats.mock.calls).toHaveLength(0);
            await writeFile(join(root, 'sources/p0/package.json'), JSON.stringify({ scripts: { changed: 'echo fresh' } }));
            const next = await inspectProjectDefinitions(root);
            expect(next.entries).toHaveLength(64);
            expect(next.entries.some(entry => entry.source.target === 'check0')).toBe(false);
            expect(next.entries).toContainEqual({ source: { kind: 'native', tool: 'package_script', file: 'sources/p0/package.json', target: 'changed' }, usage: 'script' });
            expect(stats.mock.calls).toHaveLength(0);
            await mkdir(join(root, 'linked'));
            await symlink(join(root, 'sources/p0/package.json'), join(root, 'linked/package.json'));
            await symlink(join(root, 'sources'), join(root, 'linked-directory'), 'junction');
            const linked = await inspectProjectDefinitions(root);
            expect(linked.entries).toHaveLength(65);
            expect(linked.entries).toContainEqual({ source: { kind: 'native', tool: 'package_script', file: 'linked/package.json', target: 'changed' }, usage: 'script' });
            expect(stats.mock.calls).toHaveLength(1); // Follow the package file, never directory symlinks.
        } finally { stats.mockRestore(); }
    });

    it('resolves each host tool once per inspection while retaining every file requirement and refreshing the next request', async () => {
        const tools = Array.from({ length: 128 }, (_, index) => [
            { tool: 'node', file: `packages/p${index}/package.json`, requestedVersion: index % 2 === 0 ? '22' : '24' },
            { tool: 'mise', file: `packages/p${index}/mise.toml` },
        ]).flat();
        const detection = { entries: [], toolchains: [], devcontainers: [], coverage: 'complete' as const, diagnostics: [], tools };
        const probes: string[] = [];
        let observation: 'available' | 'unavailable' | 'unresolved' = 'available';
        // Installed-tool lookup is an OS boundary. Requirement projection stays real.
        const io = { async resolveTool(tool: string, request: Readonly<{ cwd: string }>) {
            probes.push(`${tool}:${request.cwd}`);
            if (observation === 'unresolved') throw new Error('Tool lookup unavailable');
            return observation === 'available' ? { executablePath: `/installed/${tool}`, version: 'installed-version' } : null;
        } };
        for (const availability of ['available', 'unavailable', 'unresolved'] as const) {
            observation = availability;
            probes.length = 0;
            const facts = await inspectProjectToolFacts({ root: '/project', detection, candidates: [], io });
            expect(facts).toEqual(tools.map(tool => ({ ...tool, availability,
                ...(availability === 'available' ? { version: 'installed-version' } : {}) })));
            expect(probes).toEqual(['node:/project', 'mise:/project']);
        }
    });

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
        expect(detection.toolchains.map((environment) => environment.kind === 'toolchain' ? environment.tool : environment.kind)).toEqual(expect.arrayContaining(['mise', 'devbox', 'devenv', 'flox', 'nix_flake']));
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

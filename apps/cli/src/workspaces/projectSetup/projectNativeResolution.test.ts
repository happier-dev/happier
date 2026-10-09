import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectDefinitionDetectionV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { inspectProjectImportCandidates, resolveProjectDevcontainerSelection, resolveProjectEnvironmentSelection, resolveProjectNativeCommand } from './projectNativeResolution';

describe('project native resolution', () => {
    it('keeps missing or unproved tools visible, and preselects only available unambiguous intents', async () => {
        const root = await mkdtemp(join(tmpdir(), 'native-candidates-'));
        try {
            await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.6.0', scripts: { build: 'echo build' } }));
            await writeFile(join(root, 'Makefile'), 'build:\n\techo build\ncheck:\n\techo check\n');
            const detection: ProjectDefinitionDetectionV1 = { entries: [
                { source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'build' }, usage: 'script' },
                { source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'build' }, usage: 'script' },
                { source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' }, usage: 'script' },
                { source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' }, usage: 'script' },
            ], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] };
            const unbound = await inspectProjectImportCandidates({ root, detection });
            expect(unbound.every(candidate => !candidate.preselected && candidate.availability === 'unresolved')).toBe(true);
            const unproved = await inspectProjectImportCandidates({ root, detection, io: { resolveTool: async tool => ({ executablePath: `/installed/${tool}` }) } });
            expect(unproved).toEqual([
                expect.objectContaining({ source: detection.entries[0].source, availability: 'unresolved', code: 'native_tool_version_unresolved', preselected: false }),
                expect.objectContaining({ source: detection.entries[1].source, availability: 'ambiguous', preselected: false }),
                expect.objectContaining({ source: detection.entries[2].source, availability: 'available', preselected: true }),
            ]);
            const proven = await inspectProjectImportCandidates({ root, detection, io: { resolveTool: async tool => ({ executablePath: `/installed/${tool}`, version: tool === 'yarn' ? '4.6.0' : '4.4' }) } });
            expect(proven[0]).toMatchObject({ availability: 'ambiguous', preselected: false });
            expect(proven[1]).toMatchObject({ availability: 'ambiguous', preselected: false });
            const missing = await inspectProjectImportCandidates({ root, detection, io: { resolveTool: async () => null } });
            expect(missing.every(candidate => candidate.availability === 'unavailable' && !candidate.preselected)).toBe(true);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('shares package declaration/version/root, resolves argv without copying a command body or launching', async () => {
        const root = await mkdtemp(join(tmpdir(), 'native-resolution-'));
        try {
            await mkdir(join(root, 'app'));
            await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'bun@1.3.0' }));
            await writeFile(join(root, 'yarn.lock'), '');
            const content = JSON.stringify({ scripts: { dev: 'touch never-executed' } });
            await writeFile(join(root, 'app/package.json'), content);
            const result = await resolveProjectNativeCommand({ root, source: { kind: 'native', tool: 'package_script', file: 'app/package.json', target: 'dev' }, usage: 'service', io: { resolveTool: async (tool, request) => ({ executablePath: `/managed/${tool}`, version: request.version }) } });
            expect(result).toMatchObject({ kind: 'resolved', command: '/managed/bun', args: ['run', 'dev'], cwd: join(root, 'app'), packageManager: { manager: 'bun', version: '1.3.0', root } });
            expect(result.kind === 'resolved' && result.reviewInputs).toEqual([{ file: 'app/package.json', content }, { file: 'package.json', content: JSON.stringify({ packageManager: 'bun@1.3.0' }) }]);
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('selects the actual config, refuses missing/dynamic/outside refs, and marks native environment once', async () => {
        const root = await mkdtemp(join(tmpdir(), 'native-resolution-'));
        const outside = await mkdtemp(join(tmpdir(), 'native-resolution-outside-'));
        try {
            await writeFile(join(root, 'mise.toml'), '[tasks.build]\nrun="echo build"\n');
            await writeFile(join(root, '.devcontainer.json'), '{ // reviewed container\n "image": "node:22",\n}');
            await writeFile(join(root, 'Makefile'), 'include other.mk\nbuild:\n\techo build\n');
            await writeFile(join(outside, 'devbox.json'), '{}');
            await symlink(join(outside, 'devbox.json'), join(root, 'devbox.json'));
            expect(await resolveProjectEnvironmentSelection({ root, selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' } })).toMatchObject({ kind: 'selected', selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, file: 'mise.toml' });
            expect(await resolveProjectEnvironmentSelection({ root, selection: { kind: 'toolchain', tool: 'mise', configPath: '.\\mise.toml' } })).toMatchObject({ kind: 'selected', selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, file: 'mise.toml' });
            expect(await resolveProjectDevcontainerSelection({ root, selection: { configPath: '.devcontainer.json' } })).toMatchObject({ kind: 'selected', selection: { configPath: '.devcontainer.json' }, file: '.devcontainer.json' });
            expect(await resolveProjectEnvironmentSelection({ root, selection: { kind: 'toolchain', tool: 'devbox', configPath: 'devbox.json' } })).toMatchObject({ kind: 'refused', reason: 'outside_root' });
            const io = { resolveTool: async (tool: string) => ({ executablePath: `/managed/${tool}`, version: '2026.10.4' }) };
            expect(await resolveProjectNativeCommand({ root, source: { kind: 'native', tool: 'mise', file: 'mise.toml', target: 'build' }, usage: 'script', io })).toMatchObject({ kind: 'resolved', args: ['run', 'build'], nativeCommandEnvironment: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, environmentOverlay: { MISE_OVERRIDE_CONFIG_FILENAMES: join(root, 'mise.toml') } });
            expect(await resolveProjectNativeCommand({ root, source: { kind: 'native', tool: 'mise', file: 'mise.toml', target: 'build' }, usage: 'script', io: { resolveTool: async () => ({ executablePath: '/managed/runtime', args: ['/installed/mise-entrypoint'], version: '2026.10.4' }) } })).toMatchObject({ kind: 'resolved', command: '/managed/runtime', args: ['/installed/mise-entrypoint', 'run', 'build'], nativeCommandEnvironment: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' } });
            expect(await resolveProjectNativeCommand({ root, source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'build' }, usage: 'script', io })).toMatchObject({ kind: 'refused', reason: 'dynamic_unsupported' });
            expect(await resolveProjectNativeCommand({ root, source: { kind: 'native', tool: 'mise', file: 'mise.toml', target: 'gone' }, usage: 'script', io })).toMatchObject({ kind: 'refused', reason: 'missing' });
        } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
    });

    it('uses explicit files and native invocation contracts without evaluating any definition', async () => {
        const root = await mkdtemp(join(tmpdir(), 'native-resolution-'));
        try {
            const files = { Makefile: 'build:\n\techo build\n', justfile: 'build:\n  echo build\n', 'Taskfile.yml': 'version: "3"\ntasks:\n  build:\n    cmds: [echo build]\n', 'turbo.json': '{"tasks":{"build":{}}}', 'compose.yml': 'services:\n  web:\n    image: nginx\n', Procfile: 'web: echo web\n', 'devbox.json': '{"shell":{"scripts":{"build":"echo build"}}}', 'devenv.nix': '{scripts.build.exec="echo build";}', '.flox/env/manifest.toml': '[build.build]\ncommand="echo build"\n[services.web]\ncommand="echo web"\n' };
            await mkdir(join(root, '.flox/env'), { recursive: true });
            for (const [file, content] of Object.entries(files)) await writeFile(join(root, file), content);
            const io = { resolveTool: async (tool: string) => ({ executablePath: `/managed/${tool}`, version: 'current' }) };
            for (const [tool, file, target, usage, args] of [
                ['make', 'Makefile', 'build', 'script', ['-f', join(root, 'Makefile'), 'build']],
                ['just', 'justfile', 'build', 'script', ['--justfile', join(root, 'justfile'), 'build']],
                ['taskfile', 'Taskfile.yml', 'build', 'script', ['--taskfile', join(root, 'Taskfile.yml'), 'build']],
                ['turbo', 'turbo.json', 'build', 'script', ['run', 'build']],
                ['compose', 'compose.yml', 'web', 'service', ['compose', '--file', join(root, 'compose.yml'), 'up', 'web']],
                ['devbox', 'devbox.json', 'build', 'script', ['run', '--config', root, 'build']],
                ['flox', '.flox/env/manifest.toml', 'build', 'script', ['build', '--dir', root, 'build']],
                ['flox', '.flox/env/manifest.toml', 'web', 'service', ['services', 'start', '--dir', root, 'web']],
            ] as const) {
                expect(await resolveProjectNativeCommand({ root, source: { kind: 'native', tool, file, target }, usage, io })).toMatchObject({ kind: 'resolved', args });
            }
            expect(await resolveProjectNativeCommand({ root, source: { kind: 'native', tool: 'procfile', file: 'Procfile', target: 'web' }, usage: 'service', io })).toMatchObject({ kind: 'refused', code: 'procfile_runner_not_selected' });
            expect(await resolveProjectNativeCommand({ root, source: { kind: 'native', tool: 'devenv', file: 'devenv.nix', target: 'build' }, usage: 'script', io })).toMatchObject({ kind: 'resolved', args: ['shell', '--', 'build'], cwd: root, nativeCommandEnvironment: { kind: 'toolchain', tool: 'devenv', configPath: 'devenv.nix' } });
            expect(await resolveProjectNativeCommand({ root, source: { kind: 'native', tool: 'devenv', file: 'devenv.nix', target: 'computed' }, usage: 'script', io })).toMatchObject({ kind: 'refused', reason: 'dynamic_unsupported', code: 'unevaluated_nix' });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
    resolveAuthoritativePackagedRuntimeProjectRoot,
    resolvePackagedRuntimeEntrypoint,
} from './resolvePackagedRuntimeEntrypoint';

const {
  readDefaultManagedReleaseChannelSyncMock,
  resolveInstalledFirstPartyComponentPathsMock,
} = vi.hoisted(() => ({
  readDefaultManagedReleaseChannelSyncMock: vi.fn<() => PublicReleaseRingId>(() => 'publicdev'),
  resolveInstalledFirstPartyComponentPathsMock: vi.fn((_params: { channel?: string } = {}) => ({
    installRoot: '/Users/test/.happier/cli-dev',
    currentPath: '/Users/test/.happier/cli-dev/current',
    previousPath: '/Users/test/.happier/cli-dev/previous',
    versionsDir: '/Users/test/.happier/cli-dev/versions',
    binaryPath: '/Users/test/.happier/cli-dev/current/happier',
    nodeEntrypointPath: '/Users/test/.happier/cli-dev/current/package-dist/index.mjs',
    shimPaths: ['/Users/test/.happier/bin/hdev'],
    // No version marker is present in the mock environment — the resolver
    // falls back to the junction path, so the `resolved*` paths shadow the
    // non-resolved ones. (See `resolveJunctionFreeCurrentPath` for the
    // platform-specific reason these fields exist.)
    resolvedCurrentPath: '/Users/test/.happier/cli-dev/current',
    resolvedBinaryPath: '/Users/test/.happier/cli-dev/current/happier',
    resolvedNodeEntrypointPath: '/Users/test/.happier/cli-dev/current/package-dist/index.mjs',
  })),
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        existsSync: vi.fn(() => false),
    };
});

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
    return {
        ...actual,
        readDefaultManagedReleaseChannelSync: readDefaultManagedReleaseChannelSyncMock,
        resolveInstalledFirstPartyComponentPaths: resolveInstalledFirstPartyComponentPathsMock,
    };
});

vi.mock('@/projectPath', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/projectPath')>();
    return {
        ...actual,
        projectPath: () => '/repo',
    };
});

describe('resolvePackagedRuntimeEntrypoint', () => {
    const originalExecPath = process.execPath;
    const originalArgv = [...process.argv];
    afterEach(() => {
        vi.mocked(existsSync).mockReset();
        vi.mocked(existsSync).mockReturnValue(false);
        readDefaultManagedReleaseChannelSyncMock.mockReset();
        readDefaultManagedReleaseChannelSyncMock.mockReturnValue('publicdev');
        resolveInstalledFirstPartyComponentPathsMock.mockReset();
        resolveInstalledFirstPartyComponentPathsMock.mockReturnValue({
            installRoot: '/Users/test/.happier/cli-dev',
            currentPath: '/Users/test/.happier/cli-dev/current',
            previousPath: '/Users/test/.happier/cli-dev/previous',
            versionsDir: '/Users/test/.happier/cli-dev/versions',
            binaryPath: '/Users/test/.happier/cli-dev/current/happier',
            nodeEntrypointPath: '/Users/test/.happier/cli-dev/current/package-dist/index.mjs',
            shimPaths: ['/Users/test/.happier/bin/hdev'],
            resolvedCurrentPath: '/Users/test/.happier/cli-dev/current',
            resolvedBinaryPath: '/Users/test/.happier/cli-dev/current/happier',
            resolvedNodeEntrypointPath: '/Users/test/.happier/cli-dev/current/package-dist/index.mjs',
        });
        Object.defineProperty(process, 'execPath', {
            value: originalExecPath,
            configurable: true,
        });
        process.argv = [...originalArgv];
    });

    it.each([
        'file:///repo/apps/cli/src/packagedRuntime/runtimeOwner.ts',
        'file:///repo/apps/cli/dist/packagedRuntime/runtimeOwner.js',
    ])('classifies a direct source %s module before any managed-installed fallback', (moduleUrl) => {
        vi.mocked(existsSync).mockImplementation((pathLike) => {
            const path = String(pathLike);
            return path === '/repo/apps/cli/src'
                || path === '/Users/test/.happier/cli-dev/current/package-dist/index.mjs';
        });

        expect(resolveAuthoritativePackagedRuntimeProjectRoot({
            moduleUrl,
            currentExecPath: '/usr/local/bin/node',
            argv: ['/usr/local/bin/node', '/usr/local/bin/vitest'],
        })).toEqual({
            root: '/repo/apps/cli',
            provenance: 'source-module',
        });
    });

    it('classifies a dist module without a source owner as packaged authority', () => {
        expect(resolveAuthoritativePackagedRuntimeProjectRoot({
            moduleUrl: 'file:///runtime/node_modules/@happier-dev/cli/dist/runtimeOwner.js',
            currentExecPath: '/usr/local/bin/node',
            argv: ['/usr/local/bin/node', '/runtime/node_modules/@happier-dev/cli/bin/happier.mjs'],
        })).toEqual({
            root: '/runtime/node_modules/@happier-dev/cli',
            provenance: 'packaged-module',
        });
    });

    it.each([
        ['direct', '.runner-snapshots'],
        ['legacy-dist', join('dist', '.runner-snapshots')],
    ])('maps a %s source runner snapshot to its exact backing project root', (_label, snapshotDir) => {
        const sourceRoot = mkdtempSync(join(tmpdir(), 'happier-runtime-source-snapshot-'));
        mkdirSync(join(sourceRoot, 'src'), { recursive: true });
        writeFileSync(join(sourceRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
        const snapshotRoot = join(sourceRoot, snapshotDir, '0123456789abcdef');
        try {
            expect(resolveAuthoritativePackagedRuntimeProjectRoot({
                moduleUrl: pathToFileURL(join(snapshotRoot, 'chunk.js')).href,
                currentExecPath: '/usr/local/bin/node',
                argv: ['/usr/local/bin/node', join(snapshotRoot, 'index.mjs')],
                processEnv: { HAPPIER_STACK_CLI_ROOT_DIR: sourceRoot },
            })).toEqual({
                root: sourceRoot,
                provenance: 'source-snapshot',
            });
        } finally {
            rmSync(sourceRoot, { recursive: true, force: true });
        }
    });

    it('does not classify an env-matched snapshot as source without the CLI source owner', () => {
        const runtimeRoot = mkdtempSync(join(tmpdir(), 'happier-runtime-packaged-snapshot-'));
        const snapshotRoot = join(runtimeRoot, '.runner-snapshots', '0123456789abcdef');
        try {
            expect(resolveAuthoritativePackagedRuntimeProjectRoot({
                moduleUrl: pathToFileURL(join(snapshotRoot, 'chunk.js')).href,
                currentExecPath: '/usr/local/bin/node',
                argv: ['/usr/local/bin/node', join(snapshotRoot, 'index.mjs')],
                processEnv: { HAPPIER_STACK_CLI_ROOT_DIR: runtimeRoot },
            })).toEqual({
                root: runtimeRoot,
                provenance: 'packaged-snapshot',
            });
        } finally {
            rmSync(runtimeRoot, { recursive: true, force: true });
        }
    });

    it('does not classify a snapshot as source merely because its backing root contains src', () => {
        vi.mocked(existsSync).mockImplementation((pathLike) => String(pathLike) === '/runtime/current/src');

        expect(resolveAuthoritativePackagedRuntimeProjectRoot({
            moduleUrl: 'file:///runtime/current/.runner-snapshots/0123456789abcdef/chunk.js',
            currentExecPath: '/usr/local/bin/node',
            argv: ['/usr/local/bin/node', '/runtime/current/.runner-snapshots/0123456789abcdef/index.mjs'],
            processEnv: {},
        })).toEqual({
            root: '/runtime/current',
            provenance: 'packaged-snapshot',
        });
    });

    it('classifies an exact package-dist module as packaged authority', () => {
        expect(resolveAuthoritativePackagedRuntimeProjectRoot({
            moduleUrl: 'file:///runtime/current/package-dist/chunk.js',
            currentExecPath: '/usr/local/bin/node',
            argv: ['/usr/local/bin/node', '/runtime/current/package-dist/index.mjs'],
        })).toEqual({
            root: '/runtime/current',
            provenance: 'packaged-module',
        });
    });

    it('keeps package-dist authoritative when an install ancestor is named src', () => {
        expect(resolveAuthoritativePackagedRuntimeProjectRoot({
            moduleUrl: 'file:///workspace/src/npm/node_modules/@happier-dev/cli/package-dist/chunk.js',
            currentExecPath: '/usr/local/bin/node',
            argv: [
                '/usr/local/bin/node',
                '/workspace/src/npm/node_modules/@happier-dev/cli/package-dist/index.mjs',
            ],
        })).toEqual({
            root: '/workspace/src/npm/node_modules/@happier-dev/cli',
            provenance: 'packaged-module',
        });
    });

    it('keeps the exact launched payload authoritative instead of accepting another installed channel', () => {
        vi.mocked(existsSync).mockImplementation((pathLike) => (
            String(pathLike) === '/Users/test/.happier/cli-dev/current/package-dist/index.mjs'
        ));

        expect(resolveAuthoritativePackagedRuntimeProjectRoot({
            moduleUrl: 'file:///$bunfs/root/chunk.js',
            currentExecPath: '/usr/local/bin/node',
            argv: ['/usr/local/bin/node', '/runtime/active/package-dist/index.mjs'],
        })).toEqual({
            root: '/runtime/active',
            provenance: 'packaged-launch',
        });
    });

    it('returns no authority for an embedded-only launch instead of sweeping installed channels', () => {
        vi.mocked(existsSync).mockImplementation((pathLike) => (
            String(pathLike) === '/Users/test/.happier/cli-dev/current/package-dist/index.mjs'
        ));

        expect(resolveAuthoritativePackagedRuntimeProjectRoot({
            moduleUrl: 'file:///$bunfs/root/chunk.js',
            currentExecPath: '/$bunfs/root/happier',
            argv: ['/$bunfs/root/happier'],
        })).toBeNull();
    });

    it('prefers package-dist next to a self-contained cli executable when available', () => {
        Object.defineProperty(process, 'execPath', {
            value: '/runtime/current/cli/happier',
            configurable: true,
        });
        vi.mocked(existsSync).mockImplementation((pathLike) => {
            const path = String(pathLike);
            return path === '/runtime/current/cli/package-dist/backends/codex/happyMcpStdioBridge.mjs';
        });

        expect(resolvePackagedRuntimeEntrypoint('backends/codex/happyMcpStdioBridge.mjs')).toBe(
            '/runtime/current/cli/package-dist/backends/codex/happyMcpStdioBridge.mjs',
        );
    });

    it('prefers the runtime snapshot root derived from argv[1] when running under node', () => {
        Object.defineProperty(process, 'execPath', {
            value: '/usr/local/bin/node',
            configurable: true,
        });
        process.argv = ['/usr/local/bin/node', '/runtime/current/cli/package-dist/index.mjs'];
        vi.mocked(existsSync).mockImplementation((pathLike) => {
            const path = String(pathLike);
            return path === '/runtime/current/cli/package-dist/backends/codex/happyMcpStdioBridge.mjs';
        });

        expect(resolvePackagedRuntimeEntrypoint('backends/codex/happyMcpStdioBridge.mjs')).toBe(
            '/runtime/current/cli/package-dist/backends/codex/happyMcpStdioBridge.mjs',
        );
    });

    it('prefers the runtime snapshot root derived from any packaged argv entrypoint', () => {
        Object.defineProperty(process, 'execPath', {
            value: 'C:\\Program Files\\Bun\\bun.exe',
            configurable: true,
        });
        process.argv = [
            'bun',
            'B:/~BUN/root/happier.exe',
            'C:\\Users\\test\\happier-v0.2.10-windows-x64\\package-dist\\index.mjs',
            'claude',
            '--happy-starting-mode',
            'remote',
            '--started-by',
            'daemon',
        ];
        vi.mocked(existsSync).mockImplementation((pathLike) => {
            const path = String(pathLike).replaceAll('\\', '/');
            return path === 'C:/Users/test/happier-v0.2.10-windows-x64/package-dist/backends/codex/happyMcpStdioBridge.mjs';
        });

        expect(
            resolvePackagedRuntimeEntrypoint('backends/codex/happyMcpStdioBridge.mjs').replaceAll('\\', '/'),
        ).toBe('C:/Users/test/happier-v0.2.10-windows-x64/package-dist/backends/codex/happyMcpStdioBridge.mjs');
    });

    it('prefers the current argv[1] runtime snapshot over managed-installed payloads when both exist', () => {
        Object.defineProperty(process, 'execPath', {
            value: '/usr/local/bin/node',
            configurable: true,
        });
        process.argv = ['/usr/local/bin/node', '/runtime/current/cli/package-dist/index.mjs'];
        readDefaultManagedReleaseChannelSyncMock.mockReturnValue('stable');
        resolveInstalledFirstPartyComponentPathsMock.mockImplementation((params: { channel?: string } = {}) => {
            if (params.channel === 'stable') {
                return {
                    installRoot: '/Users/test/.happier/cli',
                    currentPath: '/Users/test/.happier/cli/current',
                    previousPath: '/Users/test/.happier/cli/previous',
                    versionsDir: '/Users/test/.happier/cli/versions',
                    binaryPath: '/Users/test/.happier/cli/current/happier',
                    nodeEntrypointPath: '/Users/test/.happier/cli/current/package-dist/index.mjs',
                    shimPaths: ['/Users/test/.happier/bin/happier'],
                    resolvedCurrentPath: '/Users/test/.happier/cli/versions/0.2.6',
                    resolvedBinaryPath: '/Users/test/.happier/cli/versions/0.2.6/happier',
                    resolvedNodeEntrypointPath: '/Users/test/.happier/cli/versions/0.2.6/package-dist/index.mjs',
                };
            }
            return {
                installRoot: '/Users/test/.happier/cli-preview',
                currentPath: '/Users/test/.happier/cli-preview/current',
                previousPath: '/Users/test/.happier/cli-preview/previous',
                versionsDir: '/Users/test/.happier/cli-preview/versions',
                binaryPath: '/Users/test/.happier/cli-preview/current/happier',
                nodeEntrypointPath: '/Users/test/.happier/cli-preview/current/package-dist/index.mjs',
                shimPaths: ['/Users/test/.happier/bin/hprev'],
                resolvedCurrentPath: '/Users/test/.happier/cli-preview/versions/0.2.6-preview.9',
                resolvedBinaryPath: '/Users/test/.happier/cli-preview/versions/0.2.6-preview.9/happier',
                resolvedNodeEntrypointPath: '/Users/test/.happier/cli-preview/versions/0.2.6-preview.9/package-dist/index.mjs',
            };
        });
        vi.mocked(existsSync).mockImplementation((pathLike) => {
            const path = String(pathLike);
            return (
                path === '/runtime/current/cli/package-dist/backends/codex/happyMcpStdioBridge.mjs'
                || path === '/Users/test/.happier/cli/versions/0.2.6/package-dist/index.mjs'
                || path === '/Users/test/.happier/cli/versions/0.2.6/package-dist/backends/codex/happyMcpStdioBridge.mjs'
            );
        });

        expect(resolvePackagedRuntimeEntrypoint('backends/codex/happyMcpStdioBridge.mjs')).toBe(
            '/runtime/current/cli/package-dist/backends/codex/happyMcpStdioBridge.mjs',
        );
    });

    it('prefers the managed installed cli payload root over a checkout root when running from a bundled binary', () => {
        Object.defineProperty(process, 'execPath', {
            value: '/$bunfs/root/happier',
            configurable: true,
        });
        process.argv = ['/$bunfs/root/happier'];
        vi.mocked(existsSync).mockImplementation((pathLike) => {
            const path = String(pathLike);
            return (
                path === '/Users/test/.happier/cli-dev/current/package-dist/index.mjs'
                || path === '/Users/test/.happier/cli-dev/current/package-dist/backends/codex/happyMcpStdioBridge.mjs'
                || path === '/repo/package-dist/backends/codex/happyMcpStdioBridge.mjs'
            );
        });

        expect(resolvePackagedRuntimeEntrypoint('backends/codex/happyMcpStdioBridge.mjs')).toBe(
            '/Users/test/.happier/cli-dev/current/package-dist/backends/codex/happyMcpStdioBridge.mjs',
        );
    });

    it('prefers the installed cli payload root when launched from the stable bin shim path', () => {
        Object.defineProperty(process, 'execPath', {
            value: '/Users/test/.happier/bin/happier.exe',
            configurable: true,
        });
        process.argv = ['/Users/test/.happier/bin/happier.exe'];
        vi.mocked(existsSync).mockImplementation((pathLike) => {
            const path = String(pathLike);
            return path === '/Users/test/.happier/cli/current/package-dist/backends/codex/happyMcpStdioBridge.mjs';
        });

        expect(resolvePackagedRuntimeEntrypoint('backends/codex/happyMcpStdioBridge.mjs')).toBe(
            '/Users/test/.happier/cli/current/package-dist/backends/codex/happyMcpStdioBridge.mjs',
        );
    });

    it('prefers the installed preview cli payload root when launched from the hprev shim path', () => {
        Object.defineProperty(process, 'execPath', {
            value: '/Users/test/.happier/bin/hprev',
            configurable: true,
        });
        process.argv = ['/Users/test/.happier/bin/hprev'];
        vi.mocked(existsSync).mockImplementation((pathLike) => {
            const path = String(pathLike);
            return path === '/Users/test/.happier/cli-preview/current/package-dist/backends/codex/happyMcpStdioBridge.mjs';
        });

        expect(resolvePackagedRuntimeEntrypoint('backends/codex/happyMcpStdioBridge.mjs')).toBe(
            '/Users/test/.happier/cli-preview/current/package-dist/backends/codex/happyMcpStdioBridge.mjs',
        );
    });

    it('accepts legacy preview shim names when resolving managed runtime roots', () => {
        Object.defineProperty(process, 'execPath', {
            value: '/Users/test/.happier/bin/happier-preview.exe',
            configurable: true,
        });
        process.argv = ['/Users/test/.happier/bin/happier-preview.exe'];
        vi.mocked(existsSync).mockImplementation((pathLike) => {
            const path = String(pathLike);
            return path === '/Users/test/.happier/cli-preview/current/package-dist/backends/codex/happyMcpStdioBridge.mjs';
        });

        expect(resolvePackagedRuntimeEntrypoint('backends/codex/happyMcpStdioBridge.mjs')).toBe(
            '/Users/test/.happier/cli-preview/current/package-dist/backends/codex/happyMcpStdioBridge.mjs',
        );
    });

    it('prefers the installed publicdev cli payload root when launched from the hdev shim path', () => {
        Object.defineProperty(process, 'execPath', {
            value: '/Users/test/.happier/bin/hdev.exe',
            configurable: true,
        });
        process.argv = ['/Users/test/.happier/bin/hdev.exe'];
        vi.mocked(existsSync).mockImplementation((pathLike) => {
            const path = String(pathLike);
            return path === '/Users/test/.happier/cli-dev/current/package-dist/backends/codex/happyMcpStdioBridge.mjs';
        });

        expect(resolvePackagedRuntimeEntrypoint('backends/codex/happyMcpStdioBridge.mjs')).toBe(
            '/Users/test/.happier/cli-dev/current/package-dist/backends/codex/happyMcpStdioBridge.mjs',
        );
    });

    it('uses the launched managed shim channel before the default managed channel', () => {
        readDefaultManagedReleaseChannelSyncMock.mockReturnValue('stable');
        resolveInstalledFirstPartyComponentPathsMock.mockImplementation((params: { channel?: string } = {}) => {
            if (params.channel === 'publicdev') {
                return {
                    installRoot: 'C:/Users/test/.happier/cli-dev',
                    currentPath: 'C:/Users/test/.happier/cli-dev/current',
                    previousPath: 'C:/Users/test/.happier/cli-dev/previous',
                    versionsDir: 'C:/Users/test/.happier/cli-dev/versions',
                    binaryPath: 'C:/Users/test/.happier/cli-dev/current/happier.exe',
                    nodeEntrypointPath: 'C:/Users/test/.happier/cli-dev/current/package-dist/index.mjs',
                    shimPaths: ['C:/Users/test/.happier/bin/hdev.exe'],
                    resolvedCurrentPath: 'C:/Users/test/.happier/cli-dev/versions/0.2.5-dev.102.1',
                    resolvedBinaryPath: 'C:/Users/test/.happier/cli-dev/versions/0.2.5-dev.102.1/happier.exe',
                    resolvedNodeEntrypointPath: 'C:/Users/test/.happier/cli-dev/versions/0.2.5-dev.102.1/package-dist/index.mjs',
                };
            }
            return {
                installRoot: 'C:/Users/test/.happier/cli',
                currentPath: 'C:/Users/test/.happier/cli/current',
                previousPath: 'C:/Users/test/.happier/cli/previous',
                versionsDir: 'C:/Users/test/.happier/cli/versions',
                binaryPath: 'C:/Users/test/.happier/cli/current/happier.exe',
                nodeEntrypointPath: 'C:/Users/test/.happier/cli/current/package-dist/index.mjs',
                shimPaths: ['C:/Users/test/.happier/bin/happier.exe'],
                resolvedCurrentPath: 'C:/Users/test/.happier/cli/versions/0.2.1',
                resolvedBinaryPath: 'C:/Users/test/.happier/cli/versions/0.2.1/happier.exe',
                resolvedNodeEntrypointPath: 'C:/Users/test/.happier/cli/versions/0.2.1/package-dist/index.mjs',
            };
        });
        Object.defineProperty(process, 'execPath', {
            value: 'C:\\Users\\test\\.happier\\bin\\hdev.exe',
            configurable: true,
        });
        process.argv = ['C:\\Users\\test\\.happier\\bin\\hdev.exe'];
        vi.mocked(existsSync).mockImplementation((pathLike) => {
            const path = String(pathLike).replaceAll('\\', '/');
            return path === 'C:/Users/test/.happier/cli-dev/versions/0.2.5-dev.102.1/package-dist/backends/codex/happyMcpStdioBridge.mjs'
                || path === 'C:/Users/test/.happier/cli-dev/versions/0.2.5-dev.102.1/package-dist/index.mjs';
        });

        expect(
            resolvePackagedRuntimeEntrypoint('backends/codex/happyMcpStdioBridge.mjs').replaceAll('\\', '/'),
        ).toBe('C:/Users/test/.happier/cli-dev/versions/0.2.5-dev.102.1/package-dist/backends/codex/happyMcpStdioBridge.mjs');
    });

    it('handles Windows-style stable shim and package-dist paths', () => {
        Object.defineProperty(process, 'execPath', {
            value: 'C:\\Users\\test\\.happier\\bin\\happier.exe',
            configurable: true,
        });
        process.argv = [
            'C:\\Users\\test\\.happier\\bin\\happier.exe',
            'C:\\Users\\test\\.happier\\cli\\current\\package-dist\\index.mjs',
        ];
        vi.mocked(existsSync).mockImplementation((pathLike) => {
            const path = String(pathLike).replaceAll('\\', '/');
            return path === 'C:/Users/test/.happier/cli/current/package-dist/backends/codex/happyMcpStdioBridge.mjs';
        });

        expect(
            resolvePackagedRuntimeEntrypoint('backends/codex/happyMcpStdioBridge.mjs').replaceAll('\\', '/'),
        ).toBe('C:/Users/test/.happier/cli/current/package-dist/backends/codex/happyMcpStdioBridge.mjs');
    });

    it('ignores embedded bun bundle paths and falls back to the real argv binary path', async () => {
        vi.doMock('@/projectPath', () => ({
            projectPath: () => '/$bunfs',
        }));
        vi.resetModules();

        const { resolvePackagedRuntimeEntrypoint: resolveFromEmbeddedBundle } = await import('./resolvePackagedRuntimeEntrypoint');
        Object.defineProperty(process, 'execPath', {
            value: '/$bunfs/root/happier',
            configurable: true,
        });
        process.argv = ['/runtime/current/cli/happier'];
        vi.mocked(existsSync).mockImplementation((pathLike) => {
            const path = String(pathLike);
            return path === '/runtime/current/cli/package-dist/backends/codex/happyMcpStdioBridge.mjs';
        });

        expect(resolveFromEmbeddedBundle('backends/codex/happyMcpStdioBridge.mjs')).toBe(
            '/runtime/current/cli/package-dist/backends/codex/happyMcpStdioBridge.mjs',
        );

        vi.doUnmock('@/projectPath');
        vi.resetModules();
    });

    it('falls back to any installed managed channel root when default-channel payload is unavailable under embedded bun launch', () => {
        readDefaultManagedReleaseChannelSyncMock.mockReturnValue('stable');
        resolveInstalledFirstPartyComponentPathsMock.mockImplementation((params: { channel?: string } = {}) => {
            if (params.channel === 'stable') {
                return {
                    installRoot: 'C:/Users/test/.happier/cli',
                    currentPath: 'C:/Users/test/.happier/cli/current',
                    previousPath: 'C:/Users/test/.happier/cli/previous',
                    versionsDir: 'C:/Users/test/.happier/cli/versions',
                    binaryPath: 'C:/Users/test/.happier/cli/current/happier.exe',
                    nodeEntrypointPath: 'C:/Users/test/.happier/cli/current/package-dist/index.mjs',
                    shimPaths: ['C:/Users/test/.happier/bin/happier.exe'],
                    resolvedCurrentPath: 'C:/Users/test/.happier/cli/versions/0.2.6',
                    resolvedBinaryPath: 'C:/Users/test/.happier/cli/versions/0.2.6/happier.exe',
                    resolvedNodeEntrypointPath: 'C:/Users/test/.happier/cli/versions/0.2.6/package-dist/index.mjs',
                };
            }
            if (params.channel === 'preview') {
                return {
                    installRoot: 'C:/Users/test/.happier/cli-preview',
                    currentPath: 'C:/Users/test/.happier/cli-preview/current',
                    previousPath: 'C:/Users/test/.happier/cli-preview/previous',
                    versionsDir: 'C:/Users/test/.happier/cli-preview/versions',
                    binaryPath: 'C:/Users/test/.happier/cli-preview/current/happier.exe',
                    nodeEntrypointPath: 'C:/Users/test/.happier/cli-preview/current/package-dist/index.mjs',
                    shimPaths: ['C:/Users/test/.happier/bin/hprev.exe'],
                    resolvedCurrentPath: 'C:/Users/test/.happier/cli-preview/versions/0.2.6-preview.9',
                    resolvedBinaryPath: 'C:/Users/test/.happier/cli-preview/versions/0.2.6-preview.9/happier.exe',
                    resolvedNodeEntrypointPath: 'C:/Users/test/.happier/cli-preview/versions/0.2.6-preview.9/package-dist/index.mjs',
                };
            }
            return {
                installRoot: 'C:/Users/test/.happier/cli-dev',
                currentPath: 'C:/Users/test/.happier/cli-dev/current',
                previousPath: 'C:/Users/test/.happier/cli-dev/previous',
                versionsDir: 'C:/Users/test/.happier/cli-dev/versions',
                binaryPath: 'C:/Users/test/.happier/cli-dev/current/happier.exe',
                nodeEntrypointPath: 'C:/Users/test/.happier/cli-dev/current/package-dist/index.mjs',
                shimPaths: ['C:/Users/test/.happier/bin/hdev.exe'],
                resolvedCurrentPath: 'C:/Users/test/.happier/cli-dev/versions/0.2.6-dev.1',
                resolvedBinaryPath: 'C:/Users/test/.happier/cli-dev/versions/0.2.6-dev.1/happier.exe',
                resolvedNodeEntrypointPath: 'C:/Users/test/.happier/cli-dev/versions/0.2.6-dev.1/package-dist/index.mjs',
            };
        });
        Object.defineProperty(process, 'execPath', {
            value: 'C:\\Program Files\\Bun\\bun.exe',
            configurable: true,
        });
        process.argv = ['bun', 'B:/~BUN/root/happier.exe', 'daemon', 'start'];
        vi.mocked(existsSync).mockImplementation((pathLike) => {
            const path = String(pathLike).replaceAll('\\', '/');
            return path === 'C:/Users/test/.happier/cli-preview/versions/0.2.6-preview.9/package-dist/backends/codex/happyMcpStdioBridge.mjs'
                || path === 'C:/Users/test/.happier/cli-preview/versions/0.2.6-preview.9/package-dist/index.mjs';
        });

        expect(
            resolvePackagedRuntimeEntrypoint('backends/codex/happyMcpStdioBridge.mjs').replaceAll('\\', '/'),
        ).toBe('C:/Users/test/.happier/cli-preview/versions/0.2.6-preview.9/package-dist/backends/codex/happyMcpStdioBridge.mjs');
    });
});

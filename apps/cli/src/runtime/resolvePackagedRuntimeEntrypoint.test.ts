import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';

import type { InstalledFirstPartyComponentPaths } from '@happier-dev/cli-common/firstPartyRuntime';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { resolvePackagedRuntimeEntrypoint } from './resolvePackagedRuntimeEntrypoint';

type ResolveInstalledFirstPartyComponentPathsMock = (params: Readonly<{
    componentId: 'happier-cli';
    channel?: PublicReleaseRingId;
    releaseRing?: PublicReleaseRingId;
    processEnv?: NodeJS.ProcessEnv;
}>) => InstalledFirstPartyComponentPaths;

const {
  readDefaultManagedReleaseChannelSyncMock,
  resolveInstalledFirstPartyComponentPathsMock,
} = vi.hoisted(() => ({
  readDefaultManagedReleaseChannelSyncMock: vi.fn<() => PublicReleaseRingId>(() => 'publicdev'),
  resolveInstalledFirstPartyComponentPathsMock: vi.fn<ResolveInstalledFirstPartyComponentPathsMock>(() => ({
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

vi.mock('@/projectPath', () => ({
    projectPath: () => '/repo',
}));

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
        resolveInstalledFirstPartyComponentPathsMock.mockImplementation((params) => {
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
});

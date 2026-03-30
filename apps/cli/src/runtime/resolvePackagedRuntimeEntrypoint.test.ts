import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';

import { resolvePackagedRuntimeEntrypoint } from './resolvePackagedRuntimeEntrypoint';

vi.mock('node:fs', () => ({
    existsSync: vi.fn(() => false),
}));

vi.mock('@/projectPath', () => ({
    projectPath: () => '/repo',
}));

describe('resolvePackagedRuntimeEntrypoint', () => {
    const originalExecPath = process.execPath;
    const originalArgv = [...process.argv];
    afterEach(() => {
        vi.mocked(existsSync).mockReset();
        vi.mocked(existsSync).mockReturnValue(false);
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

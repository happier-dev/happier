import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveDesiredShimTargets, writeDefaultManagedReleaseChannel } from '@happier-dev/cli-common/firstPartyRuntime';
import { resolveInstalledFirstPartyComponentPaths } from '@happier-dev/cli-common/firstPartyRuntime';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { ensureJavaScriptRuntimeExecutableMock } = vi.hoisted(() => ({
    ensureJavaScriptRuntimeExecutableMock: vi.fn(async () => '/managed/node'),
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
    ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
}));

function expectPackagedRuntimeEntrypoint(entryPath: string): void {
    expect(entryPath.replaceAll('\\', '/')).toMatch(/\/apps\/cli\/(?:package-dist|dist)\/index\.mjs$/);
}

describe('resolveDaemonServiceInstallRuntimeTarget', () => {
    let homeDir: string | null = null;

    afterEach(async () => {
        vi.restoreAllMocks();
        if (homeDir) {
            await rm(homeDir, { recursive: true, force: true });
            homeDir = null;
        }
    });

    it('prefers the movable default happier shim for default-following services when available', async () => {
        homeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-install-runtime-'));
        const processEnv = { ...process.env, HAPPIER_HOME_DIR: homeDir };
        await writeDefaultManagedReleaseChannel({ processEnv, releaseChannel: 'preview' });

        const previewShimPath = resolveInstalledFirstPartyComponentPaths({
            componentId: 'happier-daemon',
            channel: 'preview',
            processEnv,
        }).shimPaths[0];
        const defaultShimPath = (await resolveDesiredShimTargets({
            componentId: 'happier-daemon',
            channel: 'preview',
            processEnv,
        }))[0]?.shimPath;
        expect(defaultShimPath).toBeTruthy();
        expect(defaultShimPath).not.toBe(previewShimPath);
        await mkdir(dirname(defaultShimPath), { recursive: true });
        await writeFile(defaultShimPath, '# managed shim\n', 'utf8');

        const { resolveDaemonServiceInstallRuntimeTarget } = await import('./resolveDaemonServiceInstallRuntimeTarget.js');
        const resolved = await resolveDaemonServiceInstallRuntimeTarget({
            processEnv,
            targetMode: 'default-following',
            currentExecPath: '/Applications/Happier.app/Contents/MacOS/happier',
        });

        expect(resolved).toEqual({
            nodePath: defaultShimPath,
            entryPath: '',
        });
        expect(ensureJavaScriptRuntimeExecutableMock).not.toHaveBeenCalled();
    });

    it('falls back to the managed js runtime when no default-following shim is installed', async () => {
        homeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-install-runtime-'));
        const processEnv = { ...process.env, HAPPIER_HOME_DIR: homeDir };

        const { resolveDaemonServiceInstallRuntimeTarget } = await import('./resolveDaemonServiceInstallRuntimeTarget.js');
        const resolved = await resolveDaemonServiceInstallRuntimeTarget({
            processEnv,
            targetMode: 'default-following',
            currentExecPath: '/Applications/Happier.app/Contents/MacOS/happier',
        });

        expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalledWith({
            isBunRuntime: false,
            currentExecPath: '/Applications/Happier.app/Contents/MacOS/happier',
        });
        expect(resolved.nodePath).toBe('/managed/node');
        expectPackagedRuntimeEntrypoint(resolved.entryPath);
    });
});

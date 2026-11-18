import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDockerRootlessSteps } from './dockerRootless.js';
import { runMachineSetupNativeCommand } from './nativeBackend.js';

it.skipIf(process.platform !== 'linux').each([false, true])('finishes rootless setup with a distro tool whose Docker is colocated=%s', async colocated => {
    const root = await mkdtemp(join(tmpdir(), 'happier-rootless-layout-'));
    try {
        const commands = join(root, 'commands');
        const contrib = join(root, 'contrib');
        const home = join(root, 'home');
        await Promise.all([mkdir(commands), mkdir(contrib), mkdir(home)]);
        const executable = async (path: string, body: string) => writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
        // OS identity, service management, Docker and its downloaded installer are
        // external process boundaries; the generated recipe shell runs unchanged.
        await executable(join(commands, 'id'), 'case "$1" in -u) echo 1000;; *) echo happier;; esac');
        await executable(join(commands, 'cat'), 'echo 0');
        await executable(join(commands, 'runuser'), 'shift 3; exec "$@"');
        await executable(join(commands, 'systemctl'), 'exit 0');
        await executable(join(contrib, 'dockerd-rootless.sh'), 'exit 0');
        await executable(join(contrib, 'dockerd-rootless-setuptool.sh'),
            'bin=$(dirname "$(command -v dockerd-rootless.sh)"); "$bin/docker" --version; touch "$HOME/rootless-context"');
        // --version must work before installation; other Docker calls require the
        // installer-created context, making an aborted installer observable.
        const dockerBody = 'if [ "$1" = --version ]; then exit 0; fi\ntest -f "$HOME/rootless-context"';
        await executable(join(commands, 'docker'), dockerBody);
        if (colocated) await executable(join(contrib, 'docker'), dockerBody);
        const installer = join(root, 'installer');
        await executable(installer, 'touch "$HOME/downloaded-installer" "$HOME/rootless-context"');
        await executable(join(commands, 'curl'), 'while [ "$1" != -o ]; do shift; done; cp "$HAPPIER_TEST_INSTALLER" "$2"');
        const launcher = createDockerRootlessSteps('happier').find(step => step.kind === 'file');
        if (!launcher || launcher.content.kind !== 'literal') throw new Error('Missing concrete rootless launcher');
        const result = await runMachineSetupNativeCommand({ executable: 'sh', args: [],
            inputBytes: Buffer.from(launcher.content.value), env: {
                HOME: home, PATH: `${contrib}:${commands}:${process.env.PATH}`, HAPPIER_TEST_INSTALLER: installer,
            } });
        expect(result, result.stderr).toMatchObject({ code: 0 });
        expect(await readFile(join(home, 'rootless-context'), 'utf8')).toBe('');
        expect(await readFile(join(home, 'downloaded-installer'), 'utf8').then(() => true, () => false)).toBe(!colocated);
    } finally { await rm(root, { recursive: true, force: true }); }
});

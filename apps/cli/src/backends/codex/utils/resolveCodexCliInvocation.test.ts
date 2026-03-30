import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveCodexCliInvocation } from './resolveCodexCliInvocation';

async function createExecutable(params: Readonly<{ dir: string; name: string }>): Promise<string> {
    mkdirSync(params.dir, { recursive: true });
    const filePath = join(params.dir, params.name);
    writeFileSync(filePath, '#!/bin/sh\necho codex\n', 'utf8');
    chmodSync(filePath, 0o755);
    return filePath;
}

describe('resolveCodexCliInvocation', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('ignores missing app-server override paths and falls back to the provider CLI resolution', async () => {
        if (process.platform === 'win32') {
            // Windows PATH resolution + exec bits differ; current failure mode is Unix-only.
            return;
        }

        const root = await mkdtemp(join(tmpdir(), 'happier-codex-cli-invocation-'));
        const binDir = join(root, 'bin');
        const codexPath = await createExecutable({ dir: binDir, name: 'codex' });

        const originalPath = process.env.PATH ?? '';
        vi.stubEnv('PATH', `${binDir}:${originalPath}`);
        vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', join(root, 'missing-codex-app-server'));

        const invocation = await resolveCodexCliInvocation({
            args: ['app-server', '--listen', 'stdio://'],
            processEnv: process.env,
            overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN'],
            targetLabel: 'Codex app-server',
        });

        expect(invocation.command).toBe(codexPath);
    });

    it('expands ~ in override env vars before resolving the Codex CLI invocation', async () => {
        if (process.platform === 'win32') {
            // Windows home dir resolution differs; `~` expansion is primarily a Unix affordance.
            return;
        }

        const home = homedir();
        const homeTmp = await mkdtemp(join(home, '.happier-codex-cli-invocation-home-'));
        try {
            const binDir = join(homeTmp, 'bin');
            const codexPath = await createExecutable({ dir: binDir, name: 'codex-app-server' });

            const override = `~/${basename(homeTmp)}/bin/codex-app-server`;
            vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', override);

            const invocation = await resolveCodexCliInvocation({
                args: ['app-server', '--listen', 'stdio://'],
                processEnv: process.env,
                overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN'],
                targetLabel: 'Codex app-server',
            });

            expect(invocation.command).toBe(codexPath);
        } finally {
            // Best-effort cleanup under the real home dir.
            await rm(homeTmp, { recursive: true, force: true });
        }
    });

    it('ignores override paths that point at a directory and falls back to provider CLI resolution', async () => {
        if (process.platform === 'win32') {
            // Windows PATH resolution + exec bits differ; current failure mode is Unix-only.
            return;
        }

        const home = homedir();
        const homeTmp = await mkdtemp(join(home, '.happier-codex-cli-invocation-home-'));
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-cli-invocation-'));
        try {
            const homeBinDir = join(homeTmp, 'bin');
            mkdirSync(homeBinDir, { recursive: true });
            vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', `~/${basename(homeTmp)}/bin`);

            const binDir = join(root, 'bin');
            const codexPath = await createExecutable({ dir: binDir, name: 'codex' });
            const originalPath = process.env.PATH ?? '';
            vi.stubEnv('PATH', `${binDir}:${originalPath}`);

            const invocation = await resolveCodexCliInvocation({
                args: ['app-server', '--listen', 'stdio://'],
                processEnv: process.env,
                overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN'],
                targetLabel: 'Codex app-server',
            });

            expect(invocation.command).toBe(codexPath);
        } finally {
            await rm(homeTmp, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        }
    });

    it('resolves relative override paths against the provided cwd', async () => {
        if (process.platform === 'win32') {
            return;
        }

        const root = await mkdtemp(join(tmpdir(), 'happier-codex-cli-invocation-cwd-'));
        try {
            const cwd = join(root, 'project');
            const binDir = join(cwd, 'bin');
            const codexPath = await createExecutable({ dir: binDir, name: 'codex-app-server' });
            vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', './bin/codex-app-server');

            const invocation = await resolveCodexCliInvocation({
                args: ['app-server', '--listen', 'stdio://'],
                cwd,
                processEnv: process.env,
                overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN'],
                targetLabel: 'Codex app-server',
            });

            expect(invocation.command).toBe(codexPath);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

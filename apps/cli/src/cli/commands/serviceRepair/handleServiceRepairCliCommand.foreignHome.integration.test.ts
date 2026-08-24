import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { planDaemonServiceInstall, type DaemonServiceMode } from '@/daemon/service/plan';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

import { handleServiceRepairCliCommand } from './handleServiceRepairCliCommand';

type DoctorRepairJsonEnvelope = Readonly<{
    ok: boolean;
    executed: boolean;
    report: Readonly<{
        findings: readonly Readonly<{ kind: string }>[];
    }>;
    actions: readonly unknown[];
    manualWarnings: readonly string[];
}>;

function currentUidOrNull(): number | null {
    if (typeof process.getuid !== 'function') {
        return null;
    }
    try {
        return process.getuid();
    } catch {
        return null;
    }
}

function buildForeignPinnedServiceFile(params: Readonly<{
    userHomeDir: string;
    currentHappierHomeDir: string;
    foreignHappierHomeDir: string;
}>): string {
    const mode: DaemonServiceMode = 'user';
    const plan = planDaemonServiceInstall({
        platform: process.platform === 'linux' ? 'linux' : 'darwin',
        mode,
        channel: 'stable',
        targetMode: 'pinned',
        instanceId: 'cloud',
        activeServerId: 'cloud',
        userHomeDir: params.userHomeDir,
        happierHomeDir: params.foreignHappierHomeDir,
        serverUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
        publicServerUrl: 'https://api.happier.dev',
        nodePath: process.execPath,
        entryPath: '/tmp/happier-entry.mjs',
        uid: currentUidOrNull() ?? undefined,
    });
    const serviceFile = plan.files[0];
    if (!serviceFile) {
        throw new Error('Expected a planned service file');
    }
    mkdirSync(join(params.currentHappierHomeDir, 'logs'), { recursive: true });
    mkdirSync(join(params.foreignHappierHomeDir, 'logs'), { recursive: true });
    mkdirSync(join(params.userHomeDir, 'Library', 'LaunchAgents'), { recursive: true });
    mkdirSync(join(params.userHomeDir, '.config', 'systemd', 'user'), { recursive: true });
    mkdirSync(dirname(serviceFile.path), { recursive: true });
    writeFileSync(serviceFile.path, serviceFile.content, 'utf8');
    return serviceFile.path;
}

describe('handleServiceRepairCliCommand foreign-home integration', () => {
    const envScope = createEnvKeyScope([
        'HOME',
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_SERVER_URL',
        'HAPPIER_WEBAPP_URL',
        'HAPPIER_PUBLIC_SERVER_URL',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_MODE',
        'HAPPIER_DAEMON_SERVICE_SYSTEM_USER',
    ]);

    afterEach(() => {
        envScope.restore();
        reloadConfiguration();
    });

    it('surfaces foreign-home pinned current-server services as manual-warning findings with no actions', async () => {
        if (process.platform !== 'darwin' && process.platform !== 'linux') {
            return;
        }

        await withTempDir('happier-doctor-repair-foreign-home-integration-', async (tempDir) => {
            const userHomeDir = join(tempDir, 'user-home');
            const currentHappierHomeDir = join(tempDir, 'current-home');
            const foreignHappierHomeDir = join(tempDir, 'foreign-home');
            mkdirSync(userHomeDir, { recursive: true });
            mkdirSync(currentHappierHomeDir, { recursive: true });
            mkdirSync(foreignHappierHomeDir, { recursive: true });

            envScope.patch({
                HOME: userHomeDir,
                HAPPIER_HOME_DIR: currentHappierHomeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_SERVER_URL: 'https://api.happier.dev',
                HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
                HAPPIER_PUBLIC_SERVER_URL: 'https://api.happier.dev',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: userHomeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: currentHappierHomeDir,
                HAPPIER_DAEMON_SERVICE_MODE: 'user',
            });
            reloadConfiguration();

            buildForeignPinnedServiceFile({
                userHomeDir,
                currentHappierHomeDir,
                foreignHappierHomeDir,
            });

            const output = captureConsoleJsonOutput<DoctorRepairJsonEnvelope>();
            try {
                await handleServiceRepairCliCommand({
                    argv: ['repair', '--json'],
                    commandPath: 'happier doctor',
                });

                const json = output.json<DoctorRepairJsonEnvelope>();
                expect(json.ok).toBe(true);
                expect(json.executed).toBe(false);
                expect(json.report.findings.map((finding) => finding.kind)).toContain(
                    'automatic_startup_foreign_home',
                );
                expect(json.manualWarnings.length).toBeGreaterThan(0);
                expect(json.actions).toEqual([]);
            } finally {
                output.restore();
            }
        });
    });
});

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

import { uninstallDiscoveredHappierService } from './uninstallDiscoveredHappierService';

describe('uninstallDiscoveredHappierService', () => {
    it('removes an exact systemd user service definition without relying on tuple resolution', async () => {
        await withTempDir('happier-discovered-service-uninstall-', async (root) => {
            const definitionPath = join(root, '.config', 'systemd', 'user', 'happier-daemon.legacy.service');
            await mkdir(join(root, '.config', 'systemd', 'user'), { recursive: true });
            await writeFile(definitionPath, '[Unit]\nDescription=Legacy\n', 'utf8');

            await uninstallDiscoveredHappierService({
                platform: 'linux',
                backend: 'systemd-user',
                scope: 'user',
                label: 'happier-daemon.legacy',
                definitionPath,
                runCommands: false,
            });

            await expect(import('node:fs/promises').then((fs) => fs.access(definitionPath))).rejects.toThrow();
        });
    });

    it('removes an exact launchd plist for a default-following service', async () => {
        await withTempDir('happier-discovered-service-uninstall-', async (root) => {
            const definitionPath = join(root, 'Library', 'LaunchAgents', 'com.happier.cli.daemon.default.plist');
            await mkdir(join(root, 'Library', 'LaunchAgents'), { recursive: true });
            await writeFile(definitionPath, '<plist version="1.0"></plist>\n', 'utf8');

            await uninstallDiscoveredHappierService({
                platform: 'darwin',
                backend: 'launchd',
                scope: 'user',
                label: 'com.happier.cli.daemon.default',
                definitionPath,
                runCommands: false,
            });

            await expect(import('node:fs/promises').then((fs) => fs.access(definitionPath))).rejects.toThrow();
        });
    });

    it('removes an exact Windows scheduled-task wrapper script', async () => {
        await withTempDir('happier-discovered-service-uninstall-', async (root) => {
            const definitionPath = join(root, '.happier', 'services', 'happier-daemon.default.ps1');
            await mkdir(join(root, '.happier', 'services'), { recursive: true });
            await writeFile(definitionPath, 'Write-Output "legacy"\n', 'utf8');

            await uninstallDiscoveredHappierService({
                platform: 'win32',
                backend: 'schtasks-user',
                scope: 'user',
                label: 'happier-daemon.default',
                definitionPath,
                runCommands: false,
            });

            await expect(import('node:fs/promises').then((fs) => fs.access(definitionPath))).rejects.toThrow();
        });
    });
});

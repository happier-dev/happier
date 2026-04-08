import { describe, expect, it } from 'vitest';

import { runUninstallSupportCommand } from './uninstallSupportCommand.js';

describe('runUninstallSupportCommand', () => {
    it('previews a delegated uninstall using the preferred Happier CLI shim', async () => {
        const result = await runUninstallSupportCommand(
            { json: true, yes: false, dryRun: false, keepService: false },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'hdev',
                    warnings: [],
                }),
            },
        );

        expect(JSON.parse(result.output)).toEqual({
            ok: true,
            executed: false,
            actions: [
                { command: 'hdev uninstall --yes', reason: 'current-managed-installation' },
            ],
        });
    });

    it('passes through uninstall flags when executing', async () => {
        const executed: Array<{ cmd: string; args: readonly string[] }> = [];

        const result = await runUninstallSupportCommand(
            { json: true, yes: true, dryRun: true, keepService: true },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'happier',
                    warnings: [],
                }),
                runCommand: async (input) => {
                    executed.push(input);
                    return { exitCode: 0, stdout: '', stderr: '' };
                },
            },
        );

        expect(executed).toEqual([
            { cmd: 'happier', args: ['uninstall', '--yes', '--dry-run', '--keep-service'] },
        ]);
        expect(JSON.parse(result.output)).toEqual({
            ok: true,
            executed: true,
            actions: [
                { command: 'happier uninstall --yes --dry-run --keep-service', reason: 'current-managed-installation' },
            ],
        });
    });
});

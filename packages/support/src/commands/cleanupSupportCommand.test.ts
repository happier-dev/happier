import { describe, expect, it, vi } from 'vitest';

vi.mock('@happier-dev/cli-common', () => ({
    output: {
        createOutputBuilder: vi.fn(),
    },
}));

import { runCleanupSupportCommand } from './cleanupSupportCommand.js';

describe('runCleanupSupportCommand', () => {
    it('previews repair actions using the preferred Happier CLI shim', async () => {
        const result = await runCleanupSupportCommand(
            { json: true, yes: false },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'hprev',
                    warnings: [
                        {
                            code: 'DAEMON_STARTED_WITH_DIFFERENT_CLI',
                            title: 'Version mismatch',
                            severity: 'warning',
                            details: ['happier daemon restart'],
                        },
                    ],
                }),
            },
        );

        expect(JSON.parse(result.output)).toEqual({
            ok: true,
            executed: false,
            actions: [
                { command: 'hprev service repair --yes', reason: 'DAEMON_STARTED_WITH_DIFFERENT_CLI' },
            ],
        });
    });

    it('executes the derived repair actions when --yes is provided', async () => {
        const executed: Array<{ cmd: string; args: readonly string[] }> = [];

        const result = await runCleanupSupportCommand(
            { json: true, yes: true },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'happier',
                    warnings: [
                        {
                            code: 'ORPHAN_DAEMON_SERVICE',
                            title: 'Orphan daemon',
                            severity: 'warning',
                            details: ['happier doctor repair --yes'],
                        },
                    ],
                }),
                runCommand: async (input) => {
                    executed.push(input);
                    return { exitCode: 0, stdout: '', stderr: '' };
                },
            },
        );

        expect(executed).toEqual([
            { cmd: 'happier', args: ['service', 'repair', '--yes'] },
        ]);
        expect(JSON.parse(result.output)).toEqual({
            ok: true,
            executed: true,
            actions: [
                { command: 'happier service repair --yes', reason: 'ORPHAN_DAEMON_SERVICE' },
            ],
        });
    });

    it('executes a real repair command when a warning only advertises a dry-run repair preview', async () => {
        const executed: Array<{ cmd: string; args: readonly string[] }> = [];

        const result = await runCleanupSupportCommand(
            { json: true, yes: true },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'hprev',
                    warnings: [
                        {
                            code: 'DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE',
                            title: 'Duplicate daemon services',
                            severity: 'warning',
                            details: ['happier service repair --dry-run', 'happier service list --json'],
                        },
                    ],
                }),
                runCommand: async (input) => {
                    executed.push(input);
                    return { exitCode: 0, stdout: '', stderr: '' };
                },
            },
        );

        expect(executed).toEqual([
            { cmd: 'hprev', args: ['service', 'repair', '--yes'] },
        ]);
        expect(JSON.parse(result.output)).toEqual({
            ok: true,
            executed: true,
            actions: [
                { command: 'hprev service repair --yes', reason: 'DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE' },
            ],
        });
    });
});

import { describe, expect, it, vi } from 'vitest';

const {
    runDaemonServiceCliCommandMock,
    handleServiceRepairCliCommandMock,
} = vi.hoisted(() => ({
    runDaemonServiceCliCommandMock: vi.fn(async () => undefined),
    handleServiceRepairCliCommandMock: vi.fn(async () => undefined),
}));

vi.mock('@/daemon/service/cli', () => ({
    runDaemonServiceCliCommand: runDaemonServiceCliCommandMock,
}));

vi.mock('./serviceRepair/handleServiceRepairCliCommand', () => ({
    handleServiceRepairCliCommand: handleServiceRepairCliCommandMock,
}));

import { handleServiceCliCommand } from './service';
import { handleDaemonCliCommand } from './daemon';

describe('service command routing', () => {
    it('routes top-level service repair through the canonical service repair flow', async () => {
        await handleServiceCliCommand({
            args: ['service', 'repair', '--json'],
            rawArgv: ['node', 'happier', 'service', 'repair', '--json'],
            terminalRuntime: null,
        });

        expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
            argv: ['repair', '--json'],
            commandPath: 'happier service',
        });
        expect(runDaemonServiceCliCommandMock).not.toHaveBeenCalled();
    });

    it('keeps other top-level service actions routed through the daemon service CLI', async () => {
        await handleServiceCliCommand({
            args: ['service', 'install', '--json'],
            rawArgv: ['node', 'happier', 'service', 'install', '--json'],
            terminalRuntime: null,
        });

        expect(runDaemonServiceCliCommandMock).toHaveBeenCalledWith({
            argv: ['install', '--json'],
            commandPath: 'happier service',
        });
    });

    it('preserves daemon service repair as a compatibility alias', async () => {
        await handleDaemonCliCommand({
            args: ['daemon', 'service', 'repair', '--json'],
            rawArgv: ['node', 'happier', 'daemon', 'service', 'repair', '--json'],
            terminalRuntime: null,
        });

        expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
            argv: ['repair', '--json'],
            commandPath: 'happier daemon service',
        });
    });
});

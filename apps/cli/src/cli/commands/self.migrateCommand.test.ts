import { afterEach, describe, expect, it, vi } from 'vitest';

const { handleServiceRepairCliCommandMock } = vi.hoisted(() => ({
    handleServiceRepairCliCommandMock: vi.fn<(params: unknown) => Promise<void>>(async () => {}),
}));

vi.mock('./serviceRepair/handleServiceRepairCliCommand', () => ({
    handleServiceRepairCliCommand: (params: unknown) => handleServiceRepairCliCommandMock(params),
}));

describe('happier self migrate', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
        handleServiceRepairCliCommandMock.mockReset();
    });

    it('delegates to the canonical background-service repair flow', async () => {
        const { handleSelfCliCommand } = await import('./self');

        await handleSelfCliCommand({
            args: ['self', 'migrate', '--yes', '--json'],
            rawArgv: ['happier', 'self', 'migrate', '--yes', '--json'],
            terminalRuntime: null,
        });

        expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
            argv: ['repair', '--yes', '--json'],
            commandPath: 'happier self migrate',
        });
    });
});

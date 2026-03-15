import { describe, expect, it, vi } from 'vitest';

describe('ui postinstall runCommand helpers', () => {
    it('runCommandBestEffort does not call process.exit on failure', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit called');
        }) as any);

        const { runCommandBestEffort } = await import('../../../tools/postinstall/runCommand.mjs');

        const result = runCommandBestEffort({
            spawnSync: () => ({ status: 1 } as any),
            command: 'node',
            args: ['-e', 'process.exit(1)'],
        });

        expect(result.ok).toBe(false);
        expect(exitSpy).not.toHaveBeenCalled();

        exitSpy.mockRestore();
    });

    it('runCommandOrExit calls process.exit when the command fails', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit called');
        }) as any);

        const { runCommandOrExit } = await import('../../../tools/postinstall/runCommand.mjs');

        expect(() => runCommandOrExit({
            spawnSync: () => ({ status: 2 } as any),
            command: 'node',
            args: [],
        })).toThrow(/process\.exit called/);

        expect(exitSpy).toHaveBeenCalled();
        exitSpy.mockRestore();
    });
});

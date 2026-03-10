import type { Capability } from '../service';

export const windowsTerminalCapability: Capability = {
    descriptor: { id: 'tool.windowsTerminal', kind: 'tool', title: 'Windows Terminal' },
    detect: async ({ context }) => {
        return context.cliSnapshot?.windowsTerminal ?? { available: false };
    },
};

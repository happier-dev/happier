import type { Capability } from '../service';

export const windowsTerminalCapability: Capability = {
    effects: { detect: ['private_read', 'process'] },
    descriptor: { id: 'tool.windowsTerminal', kind: 'tool', title: 'Windows Terminal' },
    detect: async ({ context }) => {
        return context.cliSnapshot?.windowsTerminal ?? { available: false };
    },
};

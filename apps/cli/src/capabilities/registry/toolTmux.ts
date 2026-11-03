import type { Capability } from '../service';

export const tmuxCapability: Capability = {
    effects: { detect: ['private_read', 'process'] },
    descriptor: { id: 'tool.tmux', kind: 'tool', title: 'tmux' },
    detect: async ({ context }) => {
        return context.cliSnapshot?.tmux ?? { available: false };
    },
};

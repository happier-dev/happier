import { expect, it } from 'vitest';
import { removeUnusedNativeComposeNetworks } from './nativeComposeNetworks';

it.each([
    { exitCode: 1, reason: 'network_removal_failed' },
    { exitCode: null, reason: 'network_removal_unproved' },
])('distinguishes a Docker removal refusal from interrupted execution ($exitCode)', async ({ exitCode, reason }) => {
    expect(await removeUnusedNativeComposeNetworks({ projects: ['owned-project'],
        // Docker process outcomes are the boundary; Caddy and holder selection stay real.
        run: async args => {
            if (args[0] === 'network' && args[1] === 'ls') return { exitCode: 0, stdout: 'owned-network' };
            if (args[0] === 'container' && args[1] === 'ls' || args[0] === 'ps') return { exitCode: 0, stdout: '' };
            if (args[0] === 'network' && args[1] === 'rm') return { exitCode, stdout: '' };
            throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
        } })).toBe(reason);
});

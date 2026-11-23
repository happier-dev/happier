import { describe, expect, it } from 'vitest';
import { createBuiltinRelayAccessSelection } from '../../registry.js';
import type { RelayAccessCommandRunner, RelayAccessExecutionContext } from '../../types.js';
import { tailscaleFunnelRelayAccessProvider } from '../tailscaleFunnel/index.js';
import { tailscaleServeRelayAccessProvider } from '../tailscaleServe/index.js';

const route = {
    ownerId: 'fixture-home', hostname: 'box.tailnet.ts.net', httpsPort: 443,
    path: '/', upstream: 'http://127.0.0.1:3005',
};

function nativeRoot(upstream: string) {
    const changes: string[][] = [];
    const runCommand: RelayAccessCommandRunner = async ({ command, args }) => {
        const isStatus = args.includes('status');
        if (!isStatus) changes.push([...args]);
        return { command, args, exitCode: 0, stderr: '',
            stdout: isStatus ? `https://${route.hostname}\n|-- / proxy ${upstream}\n` : '' };
    };
    const ctx: RelayAccessExecutionContext = { env: {}, upstreamUrl: route.upstream, route,
        runCommand, resolveCommandOnPath: () => '/fixture/tailscale' };
    return { ctx, changes };
}

describe('admitted Home Relay Tailscale root mount', () => {
    it('leaves a different root upstream in place when enabling Funnel', async () => {
        const { ctx, changes } = nativeRoot('http://127.0.0.1:9999');
        const config = createBuiltinRelayAccessSelection('tailscaleFunnel');
        await expect(tailscaleFunnelRelayAccessProvider.configure?.({ config, ctx }))
            .resolves.toMatchObject({ state: 'error', details: { reason: 'tailscale_root_slot_conflict' } });
        expect(changes).toEqual([]);
    });

    it.each([
        ['tailscaleServe', tailscaleServeRelayAccessProvider, 'serve'],
        ['tailscaleFunnel', tailscaleFunnelRelayAccessProvider, 'funnel'],
    ] as const)('removes only the root mount for the reviewed upstream (%s)', async (id, provider, nativeKind) => {
        const config = createBuiltinRelayAccessSelection(id);
        const foreign = nativeRoot('http://127.0.0.1:9999');
        await expect(provider.disable?.({ config, ctx: foreign.ctx }))
            .rejects.toMatchObject({ code: 'tailscale_root_slot_conflict' });
        expect(foreign.changes).toEqual([]);

        const current = nativeRoot(route.upstream);
        await provider.disable?.({ config, ctx: current.ctx });
        expect(current.changes).toEqual([[nativeKind, '--https=443', '--set-path=/', 'off']]);
    });
});

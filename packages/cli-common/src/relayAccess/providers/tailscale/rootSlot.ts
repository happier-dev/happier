import { classifyTailscaleServeRootSlot, runTailscaleFunnelDisable, runTailscaleServeDisable,
    runTailscaleServeStatus } from '../../../tailscale/index.js';
import type { RelayAccessExecutionContext, RelayAccessProviderStatusOptions } from '../../types.js';
import { resolveTailscaleRelayAccessCommandParams, resolveTailscaleRelayAccessDeadline } from './commandParams.js';

export async function readTailscaleRelayRootSlot(
    upstream: string,
    params: Parameters<typeof runTailscaleServeStatus>[0],
    deps: Parameters<typeof runTailscaleServeStatus>[1],
    httpsPort?: number,
) {
    return classifyTailscaleServeRootSlot(await runTailscaleServeStatus(params, deps), upstream, { httpsPort });
}

/** Signed-in Home Relay teardown uses the admitted upstream, even if the native mount was replaced. */
export async function disableTailscaleRelayRoot(
    kind: 'serve' | 'funnel',
    context: RelayAccessExecutionContext,
    options: RelayAccessProviderStatusOptions,
) {
    const deadline = resolveTailscaleRelayAccessDeadline(options);
    const params = resolveTailscaleRelayAccessCommandParams(context, { ...options, deadline });
    const deps = { runCommand: context.runCommand, resolveCommandOnPath: context.resolveCommandOnPath };
    const route = context.route;
    if (route) {
        const root = await readTailscaleRelayRootSlot(route.upstream, params, deps, route.httpsPort);
        if (root.kind === 'free') return;
        if (root.kind === 'conflict') throw Object.assign(new Error('tailscale_root_slot_conflict'), { code: 'tailscale_root_slot_conflict' });
    }
    const disable = kind === 'serve' ? runTailscaleServeDisable : runTailscaleFunnelDisable;
    await disable({ ...params, ...(route ? { httpsPort: route.httpsPort, servePath: route.path } : {}) }, deps);
}

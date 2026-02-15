import type { CapabilitiesDetectContext, CapabilitiesDetectContextBuilder } from '../service';
import type { CapabilityDetectRequest } from '../types';
import { detectCliSnapshotOnDaemonPath } from '../snapshots/cliSnapshot';

export const buildDetectContext: CapabilitiesDetectContextBuilder = async (requests: CapabilityDetectRequest[]): Promise<CapabilitiesDetectContext> => {
    // Some tool probes (e.g. tool.executionRuns) need CLI availability to enrich their backend catalog.
    const wantsCliOrTmux = requests.some((r) => r.id.startsWith('cli.') || r.id === 'tool.tmux' || r.id === 'tool.executionRuns');
    const anyLogin = requests.some((r) => r.id.startsWith('cli.') && Boolean((r.params ?? {}).includeLoginStatus));
    const cliSnapshot = wantsCliOrTmux
        ? await detectCliSnapshotOnDaemonPath({ ...(anyLogin ? { includeLoginStatus: true } : {}) })
        : null;

    return { cliSnapshot };
};

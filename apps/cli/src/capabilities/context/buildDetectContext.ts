import type { DetectCliName } from '../snapshots/cliSnapshot';
import type { CapabilitiesDetectContext, CapabilitiesDetectContextBuilder } from '../service';
import type { CapabilityDetectRequest } from '../types';
import { detectCliSnapshotOnDaemonPath } from '../snapshots/cliSnapshot';

export const buildDetectContext: CapabilitiesDetectContextBuilder = async (requests: CapabilityDetectRequest[]): Promise<CapabilitiesDetectContext> => {
    // Some tool probes (e.g. tool.executionRuns) need CLI availability to enrich their backend catalog.
    const wantsCliOrTmux = requests.some((r) =>
        r.id.startsWith('cli.')
        || r.id === 'tool.tmux'
        || r.id === 'tool.windowsTerminal'
        || r.id === 'tool.executionRuns'
    );
    const anyLogin = requests.some((r) => r.id.startsWith('cli.') && Boolean((r.params ?? {}).includeLoginStatus));
    const requestedCliNames: DetectCliName[] = requests.some((r) => r.id === 'tool.executionRuns')
        ? []
        : Array.from(new Set(
            requests
                .filter((r): r is CapabilityDetectRequest & { id: `cli.${string}` } => r.id.startsWith('cli.'))
                .map((r) => r.id.slice(4) as DetectCliName)
                .filter((value) => value.length > 0),
        ));
    // Forward bypassCache from both cli.* and tool.executionRuns requests
    const bypassCache = requests.some((r) =>
        (r.id.startsWith('cli.') || r.id === 'tool.executionRuns') && Boolean((r.params ?? {}).bypassCache)
    );
    const cliSnapshot = wantsCliOrTmux
        ? await detectCliSnapshotOnDaemonPath({
            ...(anyLogin ? { includeLoginStatus: true } : {}),
            ...(requestedCliNames.length > 0 ? { requestedCliNames } : {}),
            ...(bypassCache ? { bypassCache: true } : {}),
        })
        : null;

    return { cliSnapshot };
};

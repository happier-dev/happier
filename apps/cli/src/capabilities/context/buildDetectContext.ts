import type { DetectCliName } from '../snapshots/cliSnapshot';
import type { CapabilitiesDetectContext } from '../service';
import type { CapabilityDetectRequest } from '../types';
import { detectCliSnapshotOnDaemonPath } from '../snapshots/cliSnapshot';
import type { AgentSessionFactorySource } from '@/agent/catalog/runtimeEntry';

export const buildDetectContext = async (requests: CapabilityDetectRequest[], factorySource?: AgentSessionFactorySource): Promise<CapabilitiesDetectContext> => {
    // Execution Run protocol/catalog facts come from contributions, not local
    // executable discovery. Control preflight must not scan every Agent CLI.
    const wantsCliOrTmux = requests.some((r) =>
        r.id.startsWith('cli.')
        || r.id === 'tool.tmux'
        || r.id === 'tool.windowsTerminal'
    );
    const anyLogin = requests.some((r) => r.id.startsWith('cli.') && Boolean((r.params ?? {}).includeLoginStatus));
    const requestedCliNames: DetectCliName[] = Array.from(new Set(
        requests
            .filter((r): r is CapabilityDetectRequest & { id: `cli.${string}` } => r.id.startsWith('cli.'))
            .map((r) => r.id.slice(4) as DetectCliName)
            .filter((value) => value.length > 0),
    ));
    const verifyVersion = requests.some((r) => r.id.startsWith('cli.') && Boolean((r.params ?? {}).verifyVersion));
    const bypassCache = requests.some((r) =>
        r.id.startsWith('cli.') && Boolean((r.params ?? {}).bypassCache)
    );
    const cliSnapshot = wantsCliOrTmux
        ? await detectCliSnapshotOnDaemonPath({
            ...(anyLogin ? { includeLoginStatus: true } : {}),
            ...(requestedCliNames.length > 0 ? { requestedCliNames } : {}),
            requestedTools: requests.flatMap(request => request.id === 'tool.tmux' ? ['tmux' as const]
                : request.id === 'tool.windowsTerminal' ? ['windowsTerminal' as const] : []),
            ...(bypassCache ? { bypassCache: true } : {}),
            ...(verifyVersion ? { verifyVersion: true } : {}),
        }, factorySource)
        : null;

    return { cliSnapshot };
};

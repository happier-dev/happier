import { readCurrentCatalogHook } from '@/agent/catalog/runtimeEntry';
import { resolveCliSnapshotProbeTimeoutMs } from '@/capabilities/snapshots/cliSnapshotProbeTimeout';
import { normalizeCliAuthStatusDraft } from './normalizeCliAuthStatusDraft';
import type { CliAuthSpec, CliAuthStatus } from './types';

/** Native, non-interactive auth facts from the admitted Agent's existing probe. */
export async function detectNativeAgentCliAuthStatus(params: Readonly<{
    agentId: string;
    resolvedPath: string;
    authSpec?: CliAuthSpec | null;
    processEnv?: NodeJS.ProcessEnv;
    timeoutMs?: number;
}>): Promise<CliAuthStatus | null> {
    try {
        const check = async (spec: CliAuthSpec | null | undefined): Promise<CliAuthStatus | null> => {
            if (spec?.isSafeForBackgroundChecks !== true || !spec.detectAuthStatus) return null;
            const checkedAt = Date.now();
            const draft = normalizeCliAuthStatusDraft(
                await spec.detectAuthStatus({
                    resolvedPath: params.resolvedPath,
                    processEnv: params.processEnv,
                    timeoutMs: params.timeoutMs ?? resolveCliSnapshotProbeTimeoutMs(true),
                }),
            );
            return draft ? { checkedAt, ...draft } : null;
        };
        return params.authSpec === undefined
            ? await readCurrentCatalogHook(params.agentId, async (entry) => check(await entry.getCliAuthSpec?.()))
            : await check(params.authSpec);
    } catch {
        return null;
    }
}

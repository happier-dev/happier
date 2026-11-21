import * as React from 'react';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { capturedScmFileReadKey, getScmDiffSummaryState, openCapturedScmFile,
    subscribeScmDiffSummaryHostState, type CapturedScmFileResponse } from '@/sync/ops/scmDiffSummary/generate';
import type { ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';

export function useCapturedComparisonEvidence(
    comparison: ScmComparison | null,
    options: Readonly<{
        host: ScmDiffSummaryHost | null;
        serverId?: string | null;
        comparisonSessionId?: string;
        presented?: boolean;
    }>,
) {
    const { host, serverId, comparisonSessionId, presented } = options;
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const scope = binding?.scope ?? null;
    const sessionId = host?.sessionId;
    const machineId = host?.machineId;
    const cwd = comparison?.repository.rootPath ?? '';
    const key = capturedScmFileReadKey(scope, host, cwd, comparison?.id, comparisonSessionId);
    const readSnapshot = React.useCallback(() => getScmDiffSummaryState().capturedFilesByKey?.[key]?.files ?? null, [key]);
    const subscribe = React.useCallback((listener: () => void) => scope && (sessionId || machineId)
        ? subscribeScmDiffSummaryHostState(sessionId ? { sessionId } : { machineId: machineId!, cwd },
            serverAccountScopeKeySuffix(scope), listener) : () => {},
    [scope?.serverId, scope?.accountId, sessionId, machineId, cwd]);
    const hydrated = React.useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
    const files = React.useMemo(() => new Map(comparison?.inventory.files.map(file => [file.path, file])), [comparison]);
    const resolvedComparison = React.useMemo(() => comparison && hydrated ? { ...comparison,
        inventory: { ...comparison.inventory, files: comparison.inventory.files.map(file => hydrated.get(file.path) ?? file) } }
        : comparison, [comparison, hydrated]);

    const read = React.useCallback(async (path: string): Promise<CapturedScmFileResponse> => {
        const file = readSnapshot()?.get(path) ?? files.get(path);
        if (typeof file?.evidence.unifiedDiff === 'string') return { success: true as const, diff: file.evidence.unifiedDiff };
        if (!comparison || !binding?.isCurrent() || (!sessionId && !machineId) || file?.evidence.state !== 'deferred') {
            return { success: false as const, errorCode: 'result_unavailable',
                error: file?.evidence.state === 'unavailable' ? file.evidence.reason : undefined };
        }
        return openCapturedScmFile(binding, { ...(sessionId ? { sessionId } : { machineId: machineId! }), comparisonSessionId,
            input: { cwd, comparisonId: comparison.id, source: comparison.source, path } });
    }, [binding, comparison, comparisonSessionId, cwd, files, machineId, readSnapshot, sessionId]);

    // Each presentation submits deferred paths once. Explicit Files retry
    // stays with the current diff loader.
    const attempted = React.useRef({ key, paths: new Set<string>() });
    const present = React.useCallback((path: string) => {
        if (!presented || !binding?.isCurrent() || attempted.current.key !== key || files.get(path)?.evidence.state !== 'deferred'
            || attempted.current.paths.has(path)) return;
        attempted.current.paths.add(path);
        void read(path);
    }, [binding, files, key, presented, read]);
    React.useLayoutEffect(() => {
        if (!presented || attempted.current.key !== key) attempted.current = { key, paths: new Set() };
    }, [key, presented]);
    // Only diff headers may differ between the live and captured transports.
    // The note indices and caption line numbers are valid for the same hunks.
    const matches = React.useCallback((path: string, unifiedDiff: string) => {
        const evidence = (hydrated?.get(path) ?? files.get(path))?.evidence;
        const pinned = evidence?.state === 'available' ? evidence.unifiedDiff : null;
        if (!pinned) return false;
        if (unifiedDiff === pinned) return true;
        const start = pinned.indexOf('\n@@ ');
        const displayedStart = unifiedDiff.indexOf('\n@@ ');
        return start >= 0 && displayedStart >= 0
            && pinned.slice(start).replace(/\n$/, '') === unifiedDiff.slice(displayedStart).replace(/\n$/, '');
    }, [files, hydrated]);
    return React.useMemo(() => ({ comparison: resolvedComparison, key, resolution, read, present, matches }),
        [resolvedComparison, key, resolution, read, present, matches]);
}

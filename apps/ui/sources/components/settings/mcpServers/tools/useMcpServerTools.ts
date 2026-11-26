import * as React from 'react';
import type { z } from 'zod/mini';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { resolveMcpToolLoadingV1, type McpToolLoadingV1, type McpServerToolSettingsPatchV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { t } from '@/text';

export type McpServerToolsList = z.infer<(typeof MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1)['mcp.servers.tools.list']>;

// Share only an active identical observation; settled responses remain local to each mounted consumer.
const readsInFlight = new Map<string, Promise<ActionExecuteResult>>();
function readTools(key: string, scope: ServerAccountScope, serverId: string): Promise<ActionExecuteResult> {
    const existing = readsInFlight.get(key);
    if (existing) return existing;
    // The Action captures its own Account lifetime, so either observer can leave without cancelling the other.
    const execute = createFrontDoorActionExecute();
    const pending = Promise.resolve().then(() => execute('mcp.servers.tools.list', { serverId }, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: scope.serverId, expectedAccountId: scope.accountId,
    })).finally(() => { if (readsInFlight.get(key) === pending) readsInFlight.delete(key); });
    readsInFlight.set(key, pending);
    return pending;
}

export type McpServerTools = Readonly<{
    status: 'loading' | 'ready' | 'unavailable';
    /** Why the last read failed (a diagnostic code), while `unavailable`. */
    errorCode: string | null;
    /** Last-known list; kept while a refresh or a change is in flight. */
    list: McpServerToolsList | null;
    loading: McpToolLoadingV1;
    /** The measured snapshot's every-turn baseline, also the estimate saved with on-demand loading. */
    settledTokensPerTurn: number | null;
    /** One user change = one `mcp.servers.tools.set` (D22: applied directly). Resolves with an error message on refusal. */
    set: (patch: McpServerToolSettingsPatchV1) => Promise<string | null>;
    setLoading: (loading: McpToolLoadingV1) => Promise<string | null>;
    reload: () => void;
}>;

/** Apply a patch to a list the way the server will, so the control answers on press (rolled back on refusal). */
function applyPatch(list: McpServerToolsList, patch: McpServerToolSettingsPatchV1): McpServerToolsList {
    const settings = {
        ...list.settings,
        default: patch.default ?? list.settings.default,
    };
    const delivery = patch.loading === undefined ? {} : {
        loading: patch.loading,
        effectivePromptTokens: patch.loading === 'on_demand' ? 0 : list.tokens,
        savedPromptTokens: patch.loading === 'on_demand' ? list.tokens : 0,
        perAgent: list.perAgent.status === 'ready' ? {
            ...list.perAgent,
            agents: list.perAgent.agents.map((agent) => patch.loading === 'on_demand'
                ? { ...agent, approval: 'host' as const, off: 'hidden' as const, loading: 'on_demand' as const, tokens: 0 }
                : { ...agent, loading: 'every_turn' as const, tokens: list.tokens }),
        } : list.perAgent,
    };
    if (!patch.tools || Object.keys(patch.tools).length === 0) return { ...list, ...delivery, settings };
    const overrides = { ...list.settings.tools };
    for (const [name, value] of Object.entries(patch.tools)) {
        if (value === 'inherit') delete overrides[name];
        else overrides[name] = value;
    }
    return {
        ...list,
        ...delivery,
        settings: { ...settings, tools: overrides },
        tools: list.tools.map((tool) => Object.hasOwn(overrides, tool.name)
            ? { ...tool, setting: overrides[tool.name]!, source: 'tool' as const }
            : { ...tool, setting: 'inherit' as const, source: 'server_default' as const }),
    };
}

/**
 * A server's tools and their settings through the `mcp.servers` Actions: the strict `tools.list` result
 * (snapshot, settings, cost, per-Agent facts), re-read when the catalog revision moves.
 */
export function useMcpServerTools(serverId: string | null, catalogRevision: number | 'absent' | null, installedAgentIds: readonly string[] = []): McpServerTools {
    const activeScope = useAccountSettingsScope();
    const homeId = activeScope?.serverId;
    const accountId = activeScope?.accountId;
    const scope = React.useMemo(() => (homeId && accountId ? { serverId: homeId, accountId } : null), [homeId, accountId]);
    const execution = useMountedActionExecution(scope);
    const execute = execution.execute;
    const ready = execution.ready;
    const binding = execution.binding;
    const [state, setState] = React.useState<Readonly<{ key: string | null; status: McpServerTools['status']; list: McpServerToolsList | null; errorCode?: string | null }>>(
        { key: null, status: 'loading', list: null });
    const [nonce, setNonce] = React.useState(0);
    const [writtenRevision, setWrittenRevision] = React.useState<Readonly<{ key: string | null; revision: number }>>({ key: null, revision: -1 });
    const key = scope && serverId ? JSON.stringify([scope.serverId, scope.accountId, serverId]) : null;
    // Membership, not publication timestamps or caller array identity, changes the per-Agent facts.
    const installedKey = JSON.stringify([...new Set(installedAgentIds)].sort());
    const effectiveRevision = writtenRevision.key === key && writtenRevision.revision >= 0
        && (typeof catalogRevision !== 'number' || writtenRevision.revision > catalogRevision)
        ? writtenRevision.revision : catalogRevision;
    const readKey = JSON.stringify([key, binding?.revision, effectiveRevision, installedKey, nonce]);

    React.useEffect(() => {
        // Read once the Account binding is current; asking earlier only answers "scope changed".
        if (!serverId || !scope || !ready) return;
        let cancelled = false;
        void (async () => {
            const result = await readTools(readKey, scope, serverId).catch((error: unknown) => ({
                ok: false as const, errorCode: error instanceof Error ? error.message : 'mcp_tools_list_failed', error: '' }));
            if (cancelled || !binding?.isCurrent()) return;
            const parsed = result?.ok ? MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].safeParse(result.result) : null;
            setState((current) => parsed?.success
                ? current.key === key && current.status === 'ready' && JSON.stringify(current.list) === JSON.stringify(parsed.data)
                    ? current : { key, status: 'ready', list: parsed.data }
                : { key, status: 'unavailable', list: current.key === key ? current.list : null,
                    errorCode: !result.ok ? result.errorCode ?? 'mcp_tools_list_failed' : parsed ? 'mcp_tools_list_invalid' : 'mcp_tools_list_failed' });
        })();
        return () => { cancelled = true; };
        // The read key tracks authority and facts; the mounted mutation callback is not a read invalidation.
    }, [readKey, ready, scope, serverId]);

    const current = state.key === key ? state : { key, status: 'loading' as const, list: null };
    const listRef = React.useRef(current.list);
    listRef.current = current.list;

    const noticeKey = `mcp-tools:${key}`;
    React.useEffect(() => {
        const retirement = binding?.onRetire(() => retirePresentationNotice(noticeKey));
        return () => { retirement?.dispose(); retirePresentationNotice(noticeKey); };
    }, [binding, noticeKey]);

    const change = React.useCallback(async (patch: McpServerToolSettingsPatchV1, undo = false): Promise<string | null> => {
        if (!serverId || !execution.isCurrent()) return null;
        const before = listRef.current;
        if (before) setState({ key, status: 'ready', list: applyPatch(before, patch) });
        const result = await execute('mcp.servers.tools.set', { serverId, ...patch }).catch((error: unknown) => ({
            ok: false as const, errorCode: error instanceof Error ? error.message : 'mcp_tools_set_failed', error: '' }));
        if (!execution.isCurrent()) return null;
        const parsed = result.ok ? MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.set'].safeParse(result.result) : null;
        if (!result.ok || !parsed?.success) {
            if (before) setState({ key, status: 'ready', list: before });
            if (!undo && patch.loading !== undefined) {
                publishPresentationNotice({ key: noticeKey, message: t('capabilities.mcp.tools.setFailed'), severity: 'error' });
            }
            return !result.ok ? result.errorCode ?? 'mcp_tools_set_failed' : 'invalid_action_output';
        }
        if (!binding?.isCurrent()) return null;
        setWrittenRevision((prev) => ({ key, revision: prev.key === key ? Math.max(prev.revision, parsed.data.revision) : parsed.data.revision }));
        if (undo) retirePresentationNotice(noticeKey);
        else publishPresentationNotice({ key: noticeKey, message: t('capabilities.mcp.tools.title'), severity: 'info',
            undo: { label: t('bots.undo'), run: () => {
                void change(parsed.data.previous, true).then(error => {
                    if (error) publishPresentationNotice({ key: noticeKey, message: t('capabilities.mcp.tools.setFailed'), severity: 'error' });
                });
            } } });
        return null;
    }, [execute, execution.isCurrent, key, serverId, binding, noticeKey]);
    const set = React.useCallback((patch: McpServerToolSettingsPatchV1) => change(patch), [change]);
    const setLoading = React.useCallback((loading: McpToolLoadingV1) => change({ loading }), [change]);

    const reload = React.useCallback(() => setNonce((value) => value + 1), []);
    const errorCode = current.status === 'unavailable' ? state.errorCode ?? null : null;
    const loading = current.list?.loading ?? resolveMcpToolLoadingV1(undefined);
    const settledTokensPerTurn = current.status === 'ready' ? current.list?.tokens ?? null : null;
    return React.useMemo(() => ({ status: current.status, list: current.list, errorCode, loading, settledTokensPerTurn, set, setLoading, reload }),
        [current.list, current.status, errorCode, loading, settledTokensPerTurn, reload, set, setLoading]);
}

import * as React from 'react';

import { useMcpAlwaysAllow } from '@/components/tools/shell/permissions/useMcpAlwaysAllow';
import { createRequestOwnedActionExecution } from '@/components/approvals/requestOwnedActionExecution';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionPermissionChoice } from '@/sync/ops/sessionPermissionChoices';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { listenDesktopWindowAction } from '@/utils/platform/desktopWindowActionBridge';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { emitDesktopActivityOverlayInteractionResult } from './desktopActivityOverlayBridge';

/** Main hosts the same request-owned MCP controller as the Session; the auxiliary webview has no Sync. */
export function DesktopActivityOverlayMcpPermission(props: Readonly<{
    sessionId: string; requestId: string; turnId?: string; scope: ServerAccountScope;
    choice: SessionPermissionChoice & { catalog: NonNullable<SessionPermissionChoice['catalog']> };
}>): null {
    const execute = React.useMemo(() => createRequestOwnedActionExecution(props.scope), [props.scope]);
    const always = useMcpAlwaysAllow({ requestId: props.requestId, turnId: props.turnId,
        source: props.choice.catalog.source, identity: props.choice.catalog.identity, scope: props.scope,
        canWriteCatalog: true,
        answerForSession: async () => {
            const { approved: _approved, ...response } = props.choice.response;
            requireActionSuccess(await execute('session.permission.respond', { sessionId: props.sessionId,
                requestId: props.requestId, ...(props.turnId ? { turnId: props.turnId } : {}), ...response }));
        },
    });
    const latest = React.useRef(always);
    latest.current = always;
    React.useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;
        fireAndForget(listenDesktopWindowAction(payload => {
            if (disposed || payload.windowLabel !== 'activity_overlay' || payload.actionIdentifier !== 'overlay-mcp-always-allow'
                || payload.data.serverId !== props.scope.serverId || payload.data.sessionId !== props.sessionId
                || payload.data.requestId !== props.requestId || payload.data.turnId !== props.turnId) return;
            fireAndForget((async () => {
                const result = await latest.current.allow();
                const ok = result?.status === 'saved';
                const errorCode = result?.errorCode ?? 'mcp_always_allow_unavailable';
                if (payload.requestId) await emitDesktopActivityOverlayInteractionResult({ requestId: payload.requestId, ok,
                    ...(!ok ? { errorCode, error: errorCode } : {}) });
            })(), { tag: 'DesktopActivityOverlay.mcpAlwaysAllow' });
        }).then(dispose => { if (disposed) dispose(); else unlisten = dispose; }),
        { tag: 'DesktopActivityOverlay.mcpAlwaysAllow.listen' });
        return () => { disposed = true; unlisten?.(); };
    }, [props.scope.serverId, props.sessionId, props.requestId, props.turnId]);
    return null;
}

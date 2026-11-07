import * as React from 'react';

import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { PluginSurfaceOpenOutcome } from './openPluginSurface';

/** Route owners supply their admitted href; the desktop Action owns availability and presentation. */
export function usePluginSurfaceWindowPresentation(): (href: string) => Promise<PluginSurfaceOpenOutcome> {
    const accountLifetime = useActiveServerAccountScopeLifetime();
    const execute = React.useMemo(() => createFrontDoorActionExecute(), []);
    return React.useCallback(async href => {
        if (!accountLifetime) return { ok: false, code: 'unavailable', reason: 'plugin_surface_open_origin_unavailable' };
        const { serverId, accountId } = accountLifetime.scope;
        const result = await execute('desktop.windows.open', {
            target: { kind: 'destination', serverId, accountId, href },
        }, { surface: 'ui', serverId, expectedAccountId: accountId });
        if (!result.ok) return { ok: false,
            code: result.errorCode === 'unsupported_action' ? 'unsupported_method' : 'unavailable',
            reason: result.errorCode ?? 'plugin_surface_open_window_unsupported' };
        const status = result.result && typeof result.result === 'object' ? Reflect.get(result.result, 'status') : null;
        return status === 'opened' || status === 'focused' ? { ok: true }
            : { ok: false, code: 'unavailable', reason: 'plugin_page_navigation_cancelled' };
    }, [accountLifetime, execute]);
}

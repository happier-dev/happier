import { buildTriageEntryRouteSegmentV1 } from '@happier-dev/triage-protocol/v1';
import { buildPluginAppPageRoutePath } from '@/components/plugins/pages/pluginPageRoute';

/**
 * Retired Zen paths (`/zen`, `/zen/new`, `/zen/view?id=…`, `/zen/<id>`) address the same Account task through the
 * Tasks page. The one mapping: the Expo redirect and the workspace's canonical href both read it, so the workspace
 * keeps hosting through a retained Zen link instead of withdrawing its shell for the redirect's render.
 */
export function resolveZenTasksHref(pathname: string, params: Readonly<Record<string, string | string[] | undefined>>): string | null {
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] !== 'zen' || parts.length > 2) return null;
    const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
    const segment = parts[1];
    const taskId = segment === undefined || segment === 'new' ? undefined
        : segment === 'view' ? first(params.id) : safeDecode(segment);
    if (segment !== undefined && segment !== 'new' && segment !== 'view' && taskId === undefined) return null;
    const subPath = taskId ? buildTriageEntryRouteSegmentV1({
        source: { pluginId: 'happier.triage', localId: 'internal' },
        kindId: 'task', collisionScope: 'personal', entryId: taskId,
    }) : undefined;
    return buildPluginAppPageRoutePath({ pluginId: 'happier.triage', localId: 'tasks', subPath });
}

function safeDecode(segment: string): string | undefined {
    try { return decodeURIComponent(segment); } catch { return undefined; }
}

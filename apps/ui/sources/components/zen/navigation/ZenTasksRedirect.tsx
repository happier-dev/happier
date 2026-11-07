import { Redirect, useLocalSearchParams, type Href } from 'expo-router';
import { buildTriageEntryRouteSegmentV1 } from '@happier-dev/triage-protocol/v1';
import { buildPluginAppPageRoutePath } from '@/components/plugins/pages/pluginPageRoute';

/** Retained Zen URLs address the same Account task through the Tasks page. */
export function ZenTasksRedirect() {
    const params = useLocalSearchParams<{ id?: string | string[] }>();
    const taskId = Array.isArray(params.id) ? params.id[0] : params.id;
    const subPath = taskId ? buildTriageEntryRouteSegmentV1({
        source: { pluginId: 'happier.triage', localId: 'internal' },
        kindId: 'task', collisionScope: 'personal', entryId: taskId,
    }) : undefined;
    return <Redirect href={buildPluginAppPageRoutePath({
        pluginId: 'happier.triage', localId: 'tasks', subPath,
    }) as Href} />;
}

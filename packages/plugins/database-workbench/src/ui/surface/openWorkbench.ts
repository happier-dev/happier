import { UI_DATABASE_OPEN_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import { databaseActionLocalIdV1, databaseActionMetadata, type PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { DatabaseDescriptorV1Schema, DatabaseRelationV1Schema, type DatabaseDescriptorV1 } from '@happier-dev/plugin-sdk/database';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { encodeWorkbenchPageSubPath, WorkbenchModeSchema, type WorkbenchPlace } from './subPath.js';
import { WORKBENCH_PAGE_ARTIFACT_ID, WORKBENCH_PAGE_VIEW_ID } from './views.js';

const localId = databaseActionLocalIdV1(UI_DATABASE_OPEN_ACTION_ID_V1);
const inputSchema = defineProtocolObject({
    descriptor: DatabaseDescriptorV1Schema,
    place: defineProtocolObject({
        mode: WorkbenchModeSchema,
        relation: DatabaseRelationV1Schema.optional(),
    }, { policy: 'closed' }).optional(),
}, { policy: 'closed' });
const resultSchema = defineProtocolUnion([
    defineProtocolObject({ status: defineProtocolLiteral('opened'), subPath: defineProtocolString() }, { policy: 'closed' }),
    defineProtocolObject({ status: defineProtocolLiteral('unavailable') }, { policy: 'closed' }),
]);

export const openWorkbenchActions = {
    [localId]: {
        ...databaseActionMetadata[UI_DATABASE_OPEN_ACTION_ID_V1],
        scopes: ['global'],
        surfaces: ['ui', 'agent', 'cli', 'plugin'],
        execution: { target: 'client', client: { artifactId: WORKBENCH_PAGE_ARTIFACT_ID, exportName: 'activate' },
            platforms: ['web', 'ios', 'android'] },
        inputSchema,
        resultSchema,
    },
} satisfies Record<string, PluginActionDefinition>;

/** Send a location intent through the same surface navigation port on the panel and the Action. */
export async function openWorkbenchPage(
    ui: Pick<PluginUiHostApi, 'openSurface'>,
    descriptor: Pick<DatabaseDescriptorV1, 'placement' | 'target'>,
    place?: WorkbenchPlace,
    signal?: AbortSignal,
): Promise<ReturnType<typeof resultSchema.parse>> {
    if (signal?.aborted) return { status: 'unavailable' };
    const subPath = encodeWorkbenchPageSubPath(descriptor, place);
    await ui.openSurface(WORKBENCH_PAGE_VIEW_ID, undefined, { subPath, ...(signal ? { signal } : {}) });
    return { status: 'opened', subPath };
}

export function activateWorkbenchClientActions(api: PluginClientApi): void {
    api.actions.register(localId, invokeOpenWorkbench);
}

export function invokeOpenWorkbench(input: unknown, { signal, ui }: Readonly<{
    signal: AbortSignal;
    ui: Pick<PluginUiHostApi, 'openSurface'>;
}>) {
    const { descriptor, place } = inputSchema.parse(input);
    return openWorkbenchPage(ui, descriptor, place, signal);
}

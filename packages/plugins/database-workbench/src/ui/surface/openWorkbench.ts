import { DATABASE_ACCESS_READ_ACTION_ID_V1, UI_DATABASE_DRAFT_READ_ACTION_ID_V1, UI_DATABASE_HISTORY_CLEAR_ACTION_ID_V1, UI_DATABASE_NAVIGATE_ACTION_ID_V1, UI_DATABASE_OPEN_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import type { PluginClientApi, PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import { databaseActionLocalIdV1, databaseActionMetadata, type PluginActionDefinition, type PluginClientActionContext } from '@happier-dev/plugin-sdk/actions';
import { DatabaseAccessReadResultV1Schema, DatabaseDescriptorV1Schema, DatabaseFilterV1Schema, DatabaseRelationV1Schema, type DatabaseDescriptorV1 } from '@happier-dev/plugin-sdk/database';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion, projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import type { WorkbenchInstance } from '../workbench.js';
import { encodeWorkbenchPageSubPath, WorkbenchModeSchema, type WorkbenchPlace } from './subPath.js';
import { WORKBENCH_PAGE_ARTIFACT_ID, WORKBENCH_PAGE_VIEW_ID } from './views.js';

const localId = databaseActionLocalIdV1(UI_DATABASE_OPEN_ACTION_ID_V1);
const navigateId = databaseActionLocalIdV1(UI_DATABASE_NAVIGATE_ACTION_ID_V1);
const draftReadId = databaseActionLocalIdV1(UI_DATABASE_DRAFT_READ_ACTION_ID_V1);
const historyClearId = databaseActionLocalIdV1(UI_DATABASE_HISTORY_CLEAR_ACTION_ID_V1);
const accessReadId = databaseActionLocalIdV1(DATABASE_ACCESS_READ_ACTION_ID_V1);
const client = {
    scopes: ['global'],
    surfaces: ['ui', 'agent', 'cli', 'plugin'],
    execution: { target: 'client', client: { artifactId: WORKBENCH_PAGE_ARTIFACT_ID, exportName: 'activate' },
        platforms: ['web', 'ios', 'android'] },
} as const;
const address = defineProtocolObject({ mountId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
const placeFields = { mode: WorkbenchModeSchema, relation: DatabaseRelationV1Schema.optional() };
const navigateFields = { ...placeFields, filters: DatabaseFilterV1Schema.optional() };
const navigateInput = defineProtocolObject({ address, ...navigateFields }, { policy: 'closed' });
const draftReadInput = defineProtocolObject({
    address, section: defineProtocolUnion([defineProtocolLiteral('draft'), defineProtocolLiteral('history')]),
}, { policy: 'closed' });
const historyClearInput = defineProtocolObject({ address }, { policy: 'closed' });
const unavailable = { status: 'unavailable' } as const;
const unavailableSchema = defineProtocolObject({ status: defineProtocolLiteral(unavailable.status) }, { policy: 'closed' });
const inputSchema = defineProtocolObject({
    descriptor: DatabaseDescriptorV1Schema,
    place: defineProtocolObject(placeFields, { policy: 'closed' }).optional(),
}, { policy: 'closed' });
const resultSchema = defineProtocolUnion([
    defineProtocolObject({ status: defineProtocolLiteral('opened'), subPath: defineProtocolString() }, { policy: 'closed' }),
    unavailableSchema,
]);

export const openWorkbenchActions = {
    [localId]: {
        ...databaseActionMetadata[UI_DATABASE_OPEN_ACTION_ID_V1],
        ...client,
        inputSchema,
        resultSchema,
    },
    [navigateId]: {
        ...databaseActionMetadata[UI_DATABASE_NAVIGATE_ACTION_ID_V1], ...client,
        inputSchema: navigateInput,
        resultSchema: defineProtocolUnion([unavailableSchema,
            defineProtocolObject({ status: defineProtocolLiteral('accepted'), ...navigateFields }, { policy: 'closed' }),
        ]),
    },
    [draftReadId]: {
        ...databaseActionMetadata[UI_DATABASE_DRAFT_READ_ACTION_ID_V1], ...client,
        inputSchema: draftReadInput,
        resultSchema: defineProtocolUnion([unavailableSchema,
            defineProtocolObject({ status: defineProtocolLiteral('ready'), sql: defineProtocolString() }, { policy: 'closed' }),
            defineProtocolObject({ status: defineProtocolLiteral('ready'), history: defineProtocolArray(
                defineProtocolObject({ sql: defineProtocolString() }, { policy: 'closed' }),
            ) }, { policy: 'closed' }),
        ]),
    },
    [historyClearId]: {
        ...databaseActionMetadata[UI_DATABASE_HISTORY_CLEAR_ACTION_ID_V1], ...client,
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        inputSchema: historyClearInput,
        resultSchema: defineProtocolUnion([unavailableSchema,
            defineProtocolObject({ status: defineProtocolLiteral('cleared') }, { policy: 'closed' }),
        ]),
    },
} satisfies Record<string, PluginActionDefinition>;

type MountedWorkbench = Readonly<{ instance: WorkbenchInstance; targetKey: string; signal: AbortSignal }>;
function acquireMounted(scope: PluginEphemeralSharedScope, mountId: string) {
    return scope.acquire(`database.workbench:${mountId}`, () => {
        const value = new Set<MountedWorkbench>();
        return { value, dispose: () => value.clear() };
    });
}

export function bindMountedWorkbench(scope: PluginEphemeralSharedScope, mountId: string, mounted: MountedWorkbench) {
    if (mounted.signal.aborted) return;
    const lease = acquireMounted(scope, mountId);
    if (!lease) return;
    lease.value.add(mounted);
    const release = () => {
        if (!lease.value.delete(mounted)) return;
        mounted.signal.removeEventListener('abort', release);
        lease.release();
    };
    mounted.signal.addEventListener('abort', release, { once: true });
    return release;
}

async function withMountedWorkbench<T>(
    context: PluginClientActionContext,
    mountId: string,
    invoke: (mounted: MountedWorkbench, current: () => boolean) => Promise<T>,
) {
    if (!context.ephemeralSharedScope || context.signal.aborted) return unavailable;
    const lease = acquireMounted(context.ephemeralSharedScope, mountId);
    if (!lease) return unavailable;
    try {
        const mounted = lease.value.values().next().value;
        const current = () => Boolean(mounted && lease.value.size === 1 && lease.value.has(mounted)
            && !mounted.signal.aborted && !context.signal.aborted);
        return mounted && current() ? await invoke(mounted, current) : unavailable;
    } finally {
        lease.release();
    }
}

async function withAdmittedConsoleText<T>(
    context: PluginClientActionContext,
    mountId: string,
    invoke: (text: ReturnType<WorkbenchInstance['console']>['text']) => Promise<T> | T,
) {
    return withMountedWorkbench(context, mountId, async ({ instance, targetKey }, current) => {
        // Use the invocation capability so Access Read sees the requester, regardless of who owns the page.
        const target = instance.target(targetKey).target;
        const rawAdmission = await context.ui.executeAction(accessReadId,
            projectNativeJsonValueForTransport({ target }), { signal: context.signal });
        const admission = DatabaseAccessReadResultV1Schema.safeParse(rawAdmission);
        if (!admission.success || !current()) return unavailable;
        const { text } = instance.console(targetKey);
        await text.load();
        return current() ? invoke(text) : unavailable;
    });
}

/** Send a location intent through the same surface navigation port on the panel and the Action. */
export async function openWorkbenchPage(
    ui: Pick<PluginUiHostApi, 'openSurface'>,
    descriptor: DatabaseDescriptorV1,
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
    api.actions.register(navigateId, (raw, context) => {
        const { address, mode, relation, filters } = navigateInput.parse(raw);
        return withMountedWorkbench(context, address.mountId, async ({ instance }, current) => {
            const accepted = await instance.navigate({ mode, relation, conditions: filters }, context.signal);
            return current() ? projectNativeJsonValueForTransport({
                status: 'accepted', mode: accepted.mode,
                ...(accepted.relation ? { relation: accepted.relation } : {}),
                ...(accepted.conditions ? { filters: accepted.conditions } : {}),
            }) : unavailable;
        });
    });
    api.actions.register(draftReadId, (raw, context) => {
        const { address, section } = draftReadInput.parse(raw);
        return withAdmittedConsoleText(context, address.mountId, text => {
            const value = text.get();
            return section === 'draft' ? { status: 'ready', sql: value.sql }
                : projectNativeJsonValueForTransport({ status: 'ready', history: value.history });
        });
    });
    api.actions.register(historyClearId, (raw, context) => {
        const { address } = historyClearInput.parse(raw);
        return withAdmittedConsoleText(context, address.mountId, async text => {
            await text.clearHistory();
            return { status: 'cleared' };
        });
    });
}

export function invokeOpenWorkbench(input: unknown, { signal, ui }: Readonly<{
    signal: AbortSignal;
    ui: Pick<PluginUiHostApi, 'openSurface'>;
}>) {
    const { descriptor, place } = inputSchema.parse(input);
    return openWorkbenchPage(ui, descriptor, place, signal);
}

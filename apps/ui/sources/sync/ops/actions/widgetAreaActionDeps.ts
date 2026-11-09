import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, createWidgetAreaLayoutArtifactPortV1, resolveHostWidgetAreaPresetsV1, USAGE_WIDGET_PRESET_IDS, WidgetAreaMutationErrorV1, readWidgetDefinitionArtifactSummaryV1, readWidgetSurfaceArtifactV1, type WidgetAreaPresetV1, type WidgetSurfaceRefV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';
import { selectMountedWidgetAreaLayout } from '@/sync/domains/widgets/widgetAreaLayoutSelection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { describeBuiltinWidgetInstance, readWidgetDescriptor, resolveWidgetInstanceTitle } from '@/components/widgets/widgetCatalog';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';

/** Share names, never executable definitions. Exact header demand uses the Account's existing batch reader. */
export async function readWidgetAreaTitles(account: LazyActionAccountContext, instances: readonly WidgetInstanceV1[], signal?: AbortSignal): Promise<ReadonlyMap<string, string>> {
    account.assertCurrent(); signal?.throwIfAborted();
    const ids = [...new Set(instances.flatMap(instance => instance.definition.kind === 'artifact' ? [instance.definition.artifactId] : []))];
    const headers = ids.length ? await account.readArtifactHeaders(ids, { signal }) : [];
    account.assertCurrent(); signal?.throwIfAborted();
    const summaries = new Map(headers.flatMap((result, index) => {
        const row = result.status === 'fulfilled' ? result.value : null;
        const summary = row?.ownerAccountId === account.accountId && row.rawHeader
            ? readWidgetDefinitionArtifactSummaryV1(ids[index]!, row.rawHeader) : null;
        return summary ? [[summary.artifactId, { title: summary.name }] as const] : [];
    }));
    const projection = readCurrentAppShellPluginUiProjection();
    const titles = new Map<string, string>();
    for (const instance of instances) {
        const candidate = instance.definition.kind === 'artifact' ? summaries.get(instance.definition.artifactId)
            : instance.definition.kind === 'inline' ? { title: instance.definition.definition.name }
            : (() => {
                const descriptor = readWidgetDescriptor(projection, instance.definition);
                return descriptor ? describeBuiltinWidgetInstance(descriptor, instance) : null;
            })();
        // An unavailable definition retains its old neutral fallback; it must not be saved as the person's name.
        if (candidate) titles.set(instance.id, resolveWidgetInstanceTitle(instance, candidate));
    }
    return titles;
}

export async function prepareWidgetAreaSharingV1(account: LazyActionAccountContext, resource: ArtifactSharingResourceV1, signal?: AbortSignal): Promise<void> {
    if (resource.header.kind !== 'widget-area-layout.v1') return;
    if (typeof resource.body !== 'string') throw new WidgetAreaMutationErrorV1('invalid_widget_area_record');
    const layout = readWidgetSurfaceArtifactV1({ artifactId: resource.artifactId, header: resource.header, body: resource.body });
    if (!layout) throw new WidgetAreaMutationErrorV1('invalid_widget_area_record');
    account.assertCurrent();
    if (!areServerProfileIdentifiersEquivalent(layout.surface.serverId, account.serverId)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
    await createWidgetSurfaceArtifactPortV1(account.homeHubArtifactTransport, {
        surface: { ...layout.surface, artifactId: resource.artifactId }, isCurrent: account.accountLifetime.isCurrent,
        readTitles: (instances, signal) => readWidgetAreaTitles(account, instances, signal),
    }).prepareSharing(signal);
}

type WidgetAreaLayoutDeleteContext = Parameters<NonNullable<ActionExecutorDeps['widgetAreaLayouts']>['delete']>[1];

/** The host presets a layout opens with when its mount supplies none. */
function hostWidgetAreaPresets(surface: WidgetSurfaceRefV1) {
    return resolveHostWidgetAreaPresetsV1(surface, Object.fromEntries(USAGE_WIDGET_PRESET_IDS.map(id => [id, t(`usage.presets.${id}`)])) as Record<typeof USAGE_WIDGET_PRESET_IDS[number], string>);
}

/** One area's named-layout owner over the Account's Artifact transport and the private Project reference reader. */
function createDashboardLayoutPort(account: LazyActionAccountContext, projectRows: ReturnType<typeof createUiProjectAccountRowsClient>,
    surface: WidgetSurfaceRefV1, presets: readonly WidgetAreaPresetV1[] | undefined, isCurrent?: () => boolean, context?: WidgetAreaLayoutDeleteContext) {
    account.assertCurrent();
    const list = 'list' in account.homeHubArtifactTransport ? account.homeHubArtifactTransport.list : undefined;
    const remove = 'delete' in account.homeHubArtifactTransport ? account.homeHubArtifactTransport.delete : undefined;
    if (typeof list !== 'function' || typeof remove !== 'function') throw new WidgetAreaMutationErrorV1('widget_layouts_unavailable');
    if (!areServerProfileIdentifiersEquivalent(surface.serverId, account.serverId) || surface.accountId !== account.accountId && !(surface.owner.kind === 'project' && surface.artifactId)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
    return createWidgetAreaLayoutArtifactPortV1({ ...account.homeHubArtifactTransport, list, delete: remove }, { surface, presets,
        readProjectReference: async (project, signal) => {
            try { return await projectRows.readProjectReference(project, signal, context); }
            catch (error) {
                throw new WidgetAreaMutationErrorV1(error instanceof Error && 'code' in error && typeof error.code === 'string'
                    ? error.code : 'project_account_rows_unavailable');
            }
        },
        isCurrent: () => account.accountLifetime.isCurrent() && (isCurrent?.() ?? true) });
}

/**
 * Whether the layout owner would refuse deleting this layout as a protected default. Asked before a
 * delete is offered, so no surface shows a confirmation that cannot succeed; the delete still decides.
 */
export async function readWidgetAreaLayoutDeleteProtectionV1(surface: WidgetSurfaceRefV1, signal?: AbortSignal): Promise<boolean> {
    const account = await captureLazyActionAccountContext(surface.serverId, signal);
    return createDashboardLayoutPort(account, createUiProjectAccountRowsClient(account), surface, hostWidgetAreaPresets(surface))
        .isDeleteProtected(surface, signal);
}

/** Account Artifact transport is shared with Home/WorkBoard; area identity never comes from page context. */
export function createWidgetAreaActionDepsV1(account: LazyActionAccountContext | null | undefined, resolvePresets?: (surface: WidgetSurfaceRefV1) => readonly WidgetAreaPresetV1[] | undefined, isCurrent?: () => boolean): Pick<ActionExecutorDeps, 'widgetSurfaceActions' | 'widgetAreaLayouts' | 'widgetAreaLayoutSelect'> {
    if (!account) return {};
    // Inbox replay and mounted first edits consume the same host layout producer.
    // A mount may localize or seed its defaults; callers never supply preset items.
    const presetsFor = (surface: WidgetSurfaceRefV1) => resolvePresets?.(surface) ?? hostWidgetAreaPresets(surface);
    const areaPort = (surface: WidgetSurfaceRefV1) => {
        account.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(surface.serverId, account.serverId) || surface.accountId !== account.accountId && !(surface.owner.kind === 'project' && surface.artifactId)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
        return createWidgetSurfaceArtifactPortV1(account.homeHubArtifactTransport, { surface, presets: presetsFor(surface),
            readTitles: (instances, signal) => readWidgetAreaTitles(account, instances, signal),
            isCurrent: () => account.accountLifetime.isCurrent() && (isCurrent?.() ?? true) });
    };
    const area = createWidgetAreaActionPortV1(areaPort);
    const run = async <T>(operation: () => Promise<T>) => {
        try { return await operation(); }
        catch (error) {
            if (error instanceof WidgetAreaMutationErrorV1) return { ok: false as const, errorCode: error.code, error: error.code };
            // Artifact HTTP refusals are known non-commits; retain their typed code instead of
            // allowing the generic executor catch to turn them into an unknown action failure.
            if (error instanceof HappyError && error.code && typeof error.status === 'number'
                && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
                return { ok: false as const, errorCode: error.code, error: error.message };
            }
            throw error;
        }
    };
    const areaDeps = { widgetSurfaceActions: { pluginArea: area, project: area, corePage: area } };
    const projectRows = createUiProjectAccountRowsClient(account);
    const dashboard = (surface: WidgetSurfaceRefV1, context?: WidgetAreaLayoutDeleteContext) =>
        createDashboardLayoutPort(account, projectRows, surface, presetsFor(surface), isCurrent, context);
    return { ...areaDeps, widgetAreaLayoutSelect: (surface, _context, signal) => {
        account.assertCurrent();
        return selectMountedWidgetAreaLayout(surface, signal);
    }, widgetAreaLayouts: {
        reset: (args, _context, signal) => run(() => areaPort(args.surface).resetPreset(args.expectedRevision, signal)),
        undo: (capture, _context, signal) => run(() => areaPort(capture.surface).undoReset(capture, signal)),
        list: (args, _context, signal) => run(() => dashboard(args.surface).list(signal)),
        create: (args, _context, signal) => run(() => dashboard(args.surface).create(args, signal)),
        rename: (args, _context, signal) => run(() => dashboard(args.surface).rename(args, signal)),
        delete: (args, context, signal) => run(() => dashboard(args.surface, context).delete(args, signal)),
        reorder: (args, _context, signal) => run(() => dashboard(args.surface).reorder(args, signal)),
    } };
}

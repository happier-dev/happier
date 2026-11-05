import * as React from 'react';
import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { WidgetInstanceActionInputSchemasV1, WidgetSurfaceReadV1Schema, readWidgetActionSurfaceV1, buildWidgetSurfaceArtifactIdV1, widgetAreaStockLayoutNameV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { PluginUiWidgetAreaOperationV1Schema } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiWidgetAreaPresentation } from '@happier-dev/plugin-ui/advanced';

import type { WidgetSurfaceContext, WidgetSurfaceContextSlot } from '@/components/widgets/surface/widgetSurfaceSetup';
import { widgetProvidedContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { executeWidgetEntityMovement, widgetMovementRefused } from '@/sync/ops/actions/widgetEntityMovement';
import { t } from '@/text';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { Modal } from '@/modal';
import { useWidgetAreaLayouts, type WidgetAreaLayoutsExecute } from '@/components/projects/overview/useProjectDashboards';

import { WidgetArea } from './WidgetArea';
import { useWidgetAreaLayout, type WidgetAreaPort } from './useWidgetAreaLayout';
import { WidgetAreaLayoutBar, type WidgetAreaLayoutActions, type WidgetAreaLayoutLabels } from './WidgetAreaLayoutBar';
import { WidgetAreaPresetLine } from './WidgetAreaPresetLine';
import { createWidgetAreaSelectionReadHandoff, useWidgetAreaLayoutSelectionOwner } from './widgetAreaLayoutSelection';
import { widgetAreaLayoutBaseSurface, type WidgetAreaLayoutSelectionOwner } from '@/sync/domains/widgets/widgetAreaLayoutSelection';

/** A page value as people read it: a string is itself; anything else is its compact JSON. */
function describePageValue(value: JsonValue): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The page's context as the widget owners read it: each declared value is a slot named "This page",
 * so an input with that name follows the page (lab `dashboards` PG: Checks follows the repository
 * the page is filtered by). The values stay whatever the page provides; the area's declared schema
 * admits them on every operation.
 */
export function pluginPageWidgetContext(context: Readonly<Record<string, JsonValue>>): WidgetSurfaceContext {
    const slots: Record<string, WidgetSurfaceContextSlot> = {};
    for (const [slot, value] of Object.entries(context)) {
        slots[slot] = { label: t('widgetAdd.thisPage'), value: { value, label: describePageValue(value) } };
    }
    return { slots };
}

/**
 * A plugin page's declared widget area (`<WidgetSurface area="pinned" />`): the one widget area
 * owner, reached through the mounted Host API port the page lent. Every operation carries the page's
 * current context, so the host admits it against the declared schema before reading or writing.
 */
export function PluginPageWidgetArea(props: PluginUiWidgetAreaPresentation & Readonly<{ surfaceName: string }>): React.ReactElement {
    const contextKey = stableJsonStringify(props.context);
    // Keyed by value, not identity: a page re-rendering with the same filter keeps one binding.
    const pageContext = React.useMemo(() => JSON.parse(contextKey) as Readonly<Record<string, JsonValue>>, [contextKey]);
    const { port: pagePort } = props;
    const [selected, setSelected] = React.useState<Readonly<{ port: typeof pagePort; layoutId?: string }> | null>(null);
    const selectedLayoutId = selected?.port === pagePort ? selected.layoutId : undefined;
    const context = React.useMemo(() => pluginPageWidgetContext(pageContext), [pageContext]);
    const mounted = React.useRef(true);
    const [readHandoff] = React.useState(() => createWidgetAreaSelectionReadHandoff<Awaited<ReturnType<typeof pagePort.execute>>>());
    const handoffBinding = React.useMemo(() => ({}), [pagePort, pageContext]);
    const currentBinding = React.useRef({ pagePort, pageContext });
    currentBinding.current = { pagePort, pageContext };
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; readHandoff.cancel(); }; }, [readHandoff]);
    const port = React.useMemo<WidgetAreaPort>(() => {
        // The mounted area port admits declaration, context and lifetime and supplies identity.
        // Authored page values never select a Home/Account or a different destination.
        const readMovementContext = async (destination: WidgetSurfaceRefV1, signal?: AbortSignal) => {
            const result = await pagePort.execute({ actionId: 'widgets.item.list' }, pageContext, { signal, layoutId: selectedLayoutId });
            if (!result.ok) return { ok: false, code: result.errorCode ?? 'widget_area_unavailable' } as const;
            const read = WidgetSurfaceReadV1Schema.safeParse(result.result);
            if (!read.success) return { ok: false, code: 'invalid_widget_area_result' } as const;
            if (!sameStrictJsonValue(read.data.surface, destination)) return { ok: false, code: 'widget_destination_changed' } as const;
            return { ok: true, context: { surface: read.data.surface, values: widgetProvidedContext(context) } } as const;
        };
        return {
            execute: async (operation, signal, admitted) => {
                const failed = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
                const isCurrent = () => mounted.current && currentBinding.current.pagePort === pagePort && currentBinding.current.pageContext === pageContext;
                if (!isCurrent() || signal?.aborted) return failed('widget_area_scope_retired');
                if (!admitted) {
                    const offered = operation.actionId === 'widgets.item.list' ? readHandoff.takeWhere(handoffBinding,
                        surface => surface.owner.kind === 'pluginArea' && surface.owner.area === props.area
                            && surface.owner.layoutId === selectedLayoutId, signal) : null;
                    const result = await offered;
                    if (!isCurrent() || signal?.aborted) return failed('widget_area_scope_retired');
                    return result ?? pagePort.execute(operation, pageContext, { signal, layoutId: selectedLayoutId });
                }
                if (admitted.surface.owner.kind !== 'pluginArea' || admitted.surface.owner.area !== props.area) return failed('widget_area_owner_mismatch');
                const targetContext: Record<string, JsonValue> = {};
                for (const [slot, entry] of Object.entries(admitted.context.slots ?? {})) if (entry.value) targetContext[slot] = entry.value.value;
                const options = { signal, layoutId: admitted.surface.owner.layoutId };
                // The facade owns Home/Account/page identity. Admit the displayed target through
                // that existing read before writing; a replaced facade cannot redirect the write.
                const result = await pagePort.execute({ actionId: 'widgets.item.list' }, targetContext, options);
                if (!result.ok) return result;
                const parsed = WidgetSurfaceReadV1Schema.safeParse(result.result);
                if (!parsed.success || !sameStrictJsonValue(parsed.data.surface, admitted.surface)) return failed('widget_area_owner_mismatch');
                if (!isCurrent() || signal?.aborted) return failed('widget_area_scope_retired');
                return operation.actionId === 'widgets.item.list' ? result : pagePort.execute(operation, targetContext, options);
            },
            movement: {
                readAdmission: async (ref, destination, signal) => {
                    const admitted = await readMovementContext(destination, signal);
                    if (!admitted.ok) return { status: 'refused', code: admitted.code };
                    const { readDefaultWidgetMovementAdmission } = await import('@/sync/ops/actions/defaultActionExecutor');
                    return readDefaultWidgetMovementAdmission(ref, destination, signal, admitted.context);
                },
                execute: async (effect, scope) => {
                    const move = WidgetInstanceActionInputSchemasV1['widgets.item.move'].safeParse(effect.input);
                    if (!move.success) return widgetMovementRefused('invalid_parameters', effect.preview);
                    const destination = 'to' in move.data ? move.data.to.surface : move.data.ref.surface;
                    const admitted = await readMovementContext(destination);
                    if (!admitted.ok) return widgetMovementRefused(admitted.code, effect.preview);
                    return executeWidgetEntityMovement(effect, scope, admitted.context);
                },
            },
        };
    }, [context, handoffBinding, pageContext, pagePort, props.area, readHandoff, selectedLayoutId]);
    const layout = useWidgetAreaLayout(port, context);
    const ready = layout.state.status === 'ready' ? layout.state : null;
    const baseKey = ready ? stableJsonStringify(widgetAreaLayoutBaseSurface(ready.surface)) : '';
    const base = React.useMemo(() => baseKey ? JSON.parse(baseKey) as WidgetSurfaceRefV1 : null, [baseKey]);
    const selectionOwner = React.useMemo((): WidgetAreaLayoutSelectionOwner | null => {
        if (!base) return null;
        const isCurrent = () => mounted.current && currentBinding.current.pagePort === pagePort && currentBinding.current.pageContext === pageContext;
        return { surface: base, displayedSurface: ready?.surface, isCurrent, providedContext: widgetProvidedContext(context),
            read: (destination, signal) => readHandoff.offer(destination, handoffBinding, signal, readSignal =>
                pagePort.execute({ actionId: 'widgets.item.list' }, pageContext,
                    { signal: readSignal, layoutId: 'layoutId' in destination.owner ? destination.owner.layoutId : undefined })),
            select: destination => {
                if (destination.owner.kind === 'pluginArea') setSelected({ port: pagePort, layoutId: destination.owner.layoutId });
            },
        };
    }, [base, context, handoffBinding, pageContext, pagePort, readHandoff, ready?.surface]);
    useWidgetAreaLayoutSelectionOwner(selectionOwner);
    const executeLayoutAction = React.useCallback<WidgetAreaLayoutsExecute>(async (actionId, raw) => {
        const failed = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
        const parsed = WidgetInstanceActionInputSchemasV1[actionId].safeParse(raw);
        const target = parsed.success ? readWidgetActionSurfaceV1(parsed.data) : null;
        if (!base || !parsed.success || !target || !sameStrictJsonValue(widgetAreaLayoutBaseSurface(target), base)) return failed('widget_area_owner_mismatch');
        const fields: Record<string, unknown> = { ...parsed.data };
        delete fields.surface;
        delete fields.fromSurface;
        if (actionId === 'widgets.area.layout.create') {
            const create = WidgetInstanceActionInputSchemasV1[actionId].parse(raw);
            if (create.fromSurface) {
                if (!sameStrictJsonValue(widgetAreaLayoutBaseSurface(create.fromSurface), base)) return failed('widget_area_owner_mismatch');
                fields.fromLayoutId = 'layoutId' in create.fromSurface.owner ? create.fromSurface.owner.layoutId ?? null : null;
            }
        } else if (actionId === 'widgets.area.layout.select') {
            fields.layoutId = 'layoutId' in target.owner ? target.owner.layoutId ?? null : null;
        } else if (actionId === 'widgets.area.layout.undo') {
            const { capture } = WidgetInstanceActionInputSchemasV1[actionId].parse(raw);
            const { surface: _surface, ...previousLayout } = capture.previousLayout;
            fields.capture = { expectedRevision: capture.expectedRevision, previousLayout,
                ...('layoutId' in capture.surface.owner && capture.surface.owner.layoutId ? { layoutId: capture.surface.owner.layoutId } : {}) };
        }
        const operation = PluginUiWidgetAreaOperationV1Schema.safeParse({ ...fields, actionId });
        return operation.success ? pagePort.execute(operation.data, pageContext,
            { layoutId: 'layoutId' in target.owner ? target.owner.layoutId : undefined }) : failed('invalid_widget_area_request');
    }, [base, pageContext, pagePort]);
    const layouts = useWidgetAreaLayouts({ surface: base, execute: executeLayoutAction });
    const listed = layouts.state.dashboards;
    const defaultId = base ? buildWidgetSurfaceArtifactIdV1(base) : 'default';
    const areaTitle = props.title ?? t('widgetAdd.areaPinned');
    const options = React.useMemo(() => [
        // The stock layout carries the area's own name: with no other layout its one tab is the area's
        // heading. Once stored it keeps that name (the stored stock title is a placeholder, never what
        // the page declared), so loading and settled read the same; a name the viewer chose wins.
        ...(!listed.some(row => row.artifactId === defaultId) ? [{ id: defaultId, name: areaTitle, isDefault: true }] : []),
        ...listed.map(row => ({ id: row.artifactId,
            name: row.artifactId === defaultId && row.name === widgetAreaStockLayoutNameV1(row.surface) ? areaTitle : row.name,
            isDefault: row.isDefault || row.artifactId === defaultId, edited: row.isEdited })),
    ], [areaTitle, defaultId, listed]);
    const selectedId = ready ? ready.surface.artifactId ?? buildWidgetSurfaceArtifactIdV1(ready.surface) : defaultId;
    const selectLayout = React.useCallback(async (id: string) => {
        const summary = listed.find(row => row.artifactId === id);
        if (summary) return layouts.select(summary);
        if (id !== defaultId) return { ok: false as const, errorCode: 'widget_area_layout_not_found' };
        return executeLayoutAction('widgets.area.layout.select', { surface: base });
    }, [base, defaultId, executeLayoutAction, layouts, listed]);
    const isCurrent = React.useCallback(() => mounted.current && currentBinding.current.pagePort === pagePort && currentBinding.current.pageContext === pageContext,
        [pageContext, pagePort]);
    const create = React.useCallback(async () => {
        const source = ready?.surface;
        const name = (await Modal.prompt(t('usage.board.page.newViewTitle'), undefined,
            { placeholder: t('usage.board.page.newViewPlaceholder'), confirmText: t('common.create') }))?.trim();
        if (!name || !source || !isCurrent()) return;
        const created = await layouts.create(name, source);
        if (created.ok && created.dashboard && isCurrent()) await layouts.select(created.dashboard);
    }, [isCurrent, layouts, ready?.surface]);
    const selectedSummary = listed.find(row => row.artifactId === selectedId);
    const actions = React.useMemo((): WidgetAreaLayoutActions | null => {
        if (!selectedSummary || !ready?.canEdit) return null;
        const shownName = options.find(option => option.id === selectedSummary.artifactId)?.name ?? selectedSummary.name;
        const index = listed.indexOf(selectedSummary);
        const before = listed[index - 1];
        const after = listed[index + 1];
        return {
            rename: async () => {
                const name = (await Modal.prompt(t('usage.board.page.renameViewTitle'), undefined,
                    { defaultValue: shownName, confirmText: t('common.save') }))?.trim();
                if (name && name !== shownName && isCurrent()) await layouts.rename(selectedSummary, name);
            },
            ...(before ? { moveBefore: { name: before.name, onPress: () => { if (isCurrent()) void layouts.reorder(selectedSummary, { anchorId: before.artifactId, placement: 'before' }); } } } : {}),
            ...(after ? { moveAfter: { name: after.name, onPress: () => { if (isCurrent()) void layouts.reorder(selectedSummary, { anchorId: after.artifactId, placement: 'after' }); } } } : {}),
            delete: selectedSummary.isPreset ? { disabledReason: t('projects.dashboard.defaultProtected') } : { onPress: async () => {
                if (!isCurrent()) return;
                const removed = await layouts.remove(selectedSummary);
                if (removed.ok && !removed.approvalPending && isCurrent()) await executeLayoutAction('widgets.area.layout.select', { surface: base });
            } },
        };
    }, [base, executeLayoutAction, isCurrent, layouts, listed, options, ready?.canEdit, selectedSummary]);
    const labels: WidgetAreaLayoutLabels = {
        // The area's own name, never Usage's: the selector's visible name is already the layout's.
        list: areaTitle, current: name => name,
        create: t('usage.board.page.newView'), createEllipsis: t('usage.board.page.newView'), defaultLayout: t('projects.dashboard.default'),
        actions: name => t('usage.board.page.viewActions', { name }), rename: t('usage.board.page.renameView'),
        moveBefore: name => t('usage.board.page.moveViewBefore', { name }), moveAfter: name => t('usage.board.page.moveViewAfter', { name }),
        delete: t('usage.board.page.deleteView'), deleteLabel: t('usage.board.page.deleteView'),
    };
    const testID = props.testID ?? `widget-area.${props.area}`;
    return (
        <>
        {/* One header: the layout tabs name the area (lab `p-overview`, as on Usage and a Project), so the
            area below draws no second title and adds through its one dashed line. Held while loading so
            nothing moves on arrival. */}
        <WidgetAreaLayoutBar layouts={options} selectedId={selectedId} onSelect={id => { void selectLayout(id); }}
            onCreate={ready?.canEdit ? () => { void create(); } : null} actions={actions} labels={labels} heading="section" testID={`${testID}.layouts`} />
        {ready?.preset?.isEdited ? <WidgetAreaPresetLine preset={ready.preset} surface={ready.surface} testID={`${testID}.preset`}
            presetActions={{ resetPreset: async (surface = ready.surface) => {
                const admitted = { surface, context: ready.context };
                const result = await port.execute({ actionId: 'widgets.item.list' }, undefined, admitted);
                const read = result.ok ? WidgetSurfaceReadV1Schema.safeParse(result.result) : null;
                return read?.success ? port.execute({ actionId: 'widgets.area.layout.reset', expectedRevision: read.data.revision ?? null }, undefined, admitted) : result;
            }, undoReset: capture => executeLayoutAction('widgets.area.layout.undo', { capture }) }} /> : null}
        <WidgetArea
            port={port}
            layout={layout}
            context={context}
            geometry="grid"
            title={props.title ?? t('widgetAdd.areaPinned')}
            surfaceName={props.surfaceName}
            dashboard={{ addLabel: t('widgetAdd.areaEmptyAction'), emptyTitle: props.description ?? t('widgetAdd.areaEmptyReason'), holdsEmptyLineWhileLoading: true }}
            testID={testID}
        />
        </>
    );
}

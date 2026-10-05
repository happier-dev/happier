import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { SessionPresentedSurfacePresentationTarget } from '@/components/sessions/companion/presentation/SessionPresentedSurfacePresentationTarget';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createWidgetActionInputResolverV1, WidgetMoveCaptureV1Schema } from '@happier-dev/protocol/widgets';
import { createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home';
import { createActionExecutor, createWorkBoardArtifactPortV1, type ActionExecuteResult, type ActionExecutorDeps } from '@happier-dev/protocol';
import { createWorkBoardArtifactBoundary } from '../../../../../../packages/protocol/src/boards/workBoardArtifactV1.testkit';
import { localSettingsDefaults, LocalSettingsSchema } from '@/sync/domains/settings/localSettings';
import { registerSessionPresentationOnlyTarget } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { storage } from '@/sync/domains/state/storage';
import { buildRealmQualifiedSessionCompanionPreferenceKey } from '@/components/sessions/companion/state/sessionCompanionPreferenceKey';
import { normalizeSessionCompanionPreference, setSessionCompanionInstanceInputs } from '@/components/sessions/companion/state/sessionCompanionPreference';
import { createWidgetCompanionActionDepsV1 } from './widgetCompanionActionDeps';
import { readWidgetEntityMovementAdmission, admitWidgetEntityMovement, projectWidgetEntityMovementResult, widgetEntitySourceRef } from './widgetEntityMovement';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { resolveWorkBoardEntityDrop } from '@/components/boards/model/workBoardEntityDrop';
import { projectBoardMembership } from '@/components/boards/model/boardMembership';

describe('mounted Companion widget Action dependency', () => {
    it('moves WorkBoard copies through the same native Home and WorkBoard ports and refuses missing destination context', async () => {
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'viewer-a' };
        const home = { ...scope, owner: { kind: 'home' as const } };
        const workBoard = { ...scope, owner: { kind: 'workBoard' as const, boardId: 'launch' } };
        const boundary = createWorkBoardArtifactBoundary();
        const homeHubArtifacts = createHomeHubArtifactPortV1({ ...boundary.forAccount(scope.accountId),
            read: async (id, options) => { const row = await boundary.transport.read(id, options); return row ? { ...row, ownerAccountId: scope.accountId } : null; },
        }, { accountId: scope.accountId });
        const workBoardArtifacts = createWorkBoardArtifactPortV1(boundary.transport);
        await workBoardArtifacts.apply({ kind: 'create', board: { id: 'launch', name: 'Launch' } });
        const instance = { v: 1 as const, id: 'copy-a', displayName: 'My copy', definition: { kind: 'builtin' as const, id: 'changes' },
            bindings: { count: { kind: 'value' as const, value: 3 } } };
        const sibling = { ...instance, id: 'copy-b' };
        await homeHubArtifacts.apply({ kind: 'widget_add', instance });
        await homeHubArtifacts.apply({ kind: 'widget_add', instance: sibling });
        const deps = { homeHubArtifacts, workBoardArtifacts, widgetAccountScope: () => scope,
            widgetInputs: createWidgetActionInputResolverV1({
                readDescriptor: async () => ({ inputs: { fields: [{ path: 'count', title: 'Count', widget: 'integer' }] },
                    inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }),
                readContext: async request => {
                    const context: Readonly<Record<string, readonly import('@happier-dev/protocol').JsonValue[]>> = request.ref.surface.owner.kind === 'home' ? { sessionCount: [3] } : {};
                    return context;
                }, readViewerValues: async () => ({ values: {} }),
                validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
            }),
        // Boundary fixture supplies only this Action family's ports; an unexpected family fails loudly.
        } as unknown as ActionExecutorDeps;
        const executor = createActionExecutor(deps);
        const homeRef = { surface: home, instanceId: instance.id };
        await executor.execute('widgets.instance.inputs.set', { ref: homeRef, bindings: { count: { kind: 'context', slot: 'sessionCount' } } }, { surface: 'mcp', bypassApprovals: true });
        expect(await readWidgetEntityMovementAdmission(deps, homeRef, workBoard, { surface: 'mcp' }))
            .toMatchObject({ status: 'refused', code: 'widget_context_missing' });
        expect((await homeHubArtifacts.read()).instances.map(copy => copy.id)).toEqual([instance.id, sibling.id]);
        await executor.execute('widgets.instance.inputs.set', { ref: homeRef, bindings: instance.bindings }, { surface: 'mcp', bypassApprovals: true });
        const board = await workBoardArtifacts.readBoard('launch');
        if (!board) throw new Error('Expected the real WorkBoard');
        const admission = resolveWorkBoardEntityDrop({ item: { kind: 'home-section', scope, sectionId: instance.id },
            context: { scope, board, membership: projectBoardMembership(board, { isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true },
            destination: null, canvasAvailable: false });
        expect(admission.status).toBe('allowed');
        if (admission.status !== 'allowed') throw new Error('Expected configured transfer');
        const runtime = createEntityDragDropRuntime();
        const preflight = await readWidgetEntityMovementAdmission(deps, homeRef, workBoard, { surface: 'mcp' });
        runtime.registerSource({ id: 'home', scope, isCurrent: () => true, getItem: () => ({ kind: 'home-section', scope, sectionId: instance.id }) });
        runtime.registerTarget({ id: 'work-board', scope, acceptedKinds: ['home-section'], getBounds: () => null,
            resolve: () => admitWidgetEntityMovement(admission.effect, preflight),
            execute: async effect => projectWidgetEntityMovementResult(await executor.execute('widgets.instance.move', effect.input, { surface: 'mcp', bypassApprovals: true }), effect),
        });
        const carry = runtime.begin('home', 'keyboard'); carry?.choose('work-board');
        expect(await carry?.release()).toEqual({ status: 'applied' });
        expect((await homeHubArtifacts.read()).instances).toEqual([sibling]);
        expect((await workBoardArtifacts.readBoard('launch'))?.widgets?.map(copy => copy.instance)).toEqual([instance]);
        const ref = widgetEntitySourceRef({ kind: 'work-board-widget', scope, boardId: 'launch', instanceId: instance.id });
        expect(ref).toEqual({ surface: workBoard, instanceId: instance.id });
        expect(await executor.execute('widgets.instance.move', { ref, to: { surface: home, index: 0 } }, { surface: 'mcp', bypassApprovals: true }))
            .toMatchObject({ ok: true, result: { status: 'moved', fromRef: ref, ref: homeRef } });
        expect((await homeHubArtifacts.read()).instances.filter(copy => copy.id === instance.id)).toEqual([instance]);
        expect((await workBoardArtifacts.readBoard('launch'))?.widgets).toEqual([]);
    });
    it('moves a Home copy before legacy Companion content through the public Action and both real owners', async () => {
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'viewer-a' };
        const home = { ...scope, owner: { kind: 'home' as const } };
        const companion = { ...scope, owner: { kind: 'companion' as const, sessionId: 'session-a' } };
        const key = buildRealmQualifiedSessionCompanionPreferenceKey(scope, 'session-a');
        if (!key) throw new Error('Expected a qualified Companion preference key');
        const instance = { v: 1 as const, id: 'copy-a', displayName: 'My summary', definition: { kind: 'builtin' as const, id: 'session_summary' },
            bindings: { count: { kind: 'value' as const, value: 3 } } };
        const sibling = { ...instance, id: 'copy-b', bindings: { count: { kind: 'value' as const, value: 8 } } };
        const boundary = createWorkBoardArtifactBoundary();
        let transferring = false;
        const homeHubArtifacts = createHomeHubArtifactPortV1({ ...boundary.forAccount(scope.accountId),
            read: async (id, options) => { const row = await boundary.transport.read(id, options); return row ? { ...row, ownerAccountId: scope.accountId } : null; },
            update: async request => {
                if (transferring) expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1[key]?.items[0])
                    .toEqual({ kind: 'instance', instance, frameStyle: 'plain' });
                return boundary.transport.update(request);
            },
        }, { accountId: scope.accountId });
        await homeHubArtifacts.apply({ kind: 'widget_add', instance });
        await homeHubArtifacts.apply({ kind: 'frameStyle', sectionId: instance.id, frameStyle: 'plain' });
        await homeHubArtifacts.apply({ kind: 'widget_add', instance: sibling });
        const initial = normalizeSessionCompanionPreference({ v: 1, visible: true, collapsed: false, edge: 'trailing', density: 'compact',
            items: [{ kind: 'builtin', id: 'session_summary' }, { kind: 'widget', widgetId: 'shared' }] });
        const previous = storage.getState();
        storage.setState({ profileScope: scope, localSettings: LocalSettingsSchema.parse({ ...localSettingsDefaults, sessionCompanionPreferencesBySessionV1: { [key]: initial } }) });
        const renderer = await renderScreen(React.createElement(SessionPresentedSurfacePresentationTarget, {
            sessionId: 'session-a', serverId: scope.serverId, presented: true,
            openBoard: () => ({ status: 'unchanged' as const }), revealBoardItem: () => ({ status: 'unchanged' as const }),
            returnToChat: () => ({ status: 'unchanged' as const }), openFullSurface: () => ({ status: 'unchanged' as const }),
        }));
        try {
            const mounted = createWidgetCompanionActionDepsV1({ ...scope, accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) }, assertCurrent() {} });
            const deps = { ...mounted, homeHubArtifacts, widgetAccountScope: () => scope,
                // Fixed descriptor facts are the host boundary; binding and strict input-schema admission remain real.
                widgetInputs: createWidgetActionInputResolverV1({
                    readDescriptor: async () => ({ inputs: { fields: [{ path: 'count', title: 'Count', widget: 'integer' }] },
                        inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }),
                    readContext: async request => {
                        const context: Readonly<Record<string, readonly import('@happier-dev/protocol').JsonValue[]>> = request.ref.surface.owner.kind === 'companion' ? { sessionCount: [3] } : {};
                        return context;
                    }, readViewerValues: async () => ({ values: {} }),
                    validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
                }),
            } as unknown as ActionExecutorDeps;
            const executor = createActionExecutor(deps);
            const ref = { surface: home, instanceId: instance.id };
            const admission = await readWidgetEntityMovementAdmission(deps, ref, companion, { surface: 'mcp', bypassApprovals: true });
            expect(admission).toMatchObject({ status: 'ready', ref, instance });
            expect(admitWidgetEntityMovement({ actionId: 'widgets.instance.move', input: { ref, to: { surface: home, index: 0 } },
                preview: { verb: 'Move', target: 'Home' } }, admission))
                .toMatchObject({ status: 'refused', reason: { code: 'widget_destination_changed' } });
            expect(await readWidgetEntityMovementAdmission({ ...deps, widgetAccountScope: () => null }, ref, companion, { surface: 'mcp' }))
                .toEqual({ status: 'refused', code: 'widget_scope_unavailable' });
            await homeHubArtifacts.apply({ kind: 'widget_inputs', instanceId: instance.id, bindings: { count: { kind: 'value', value: 'invalid count' } } });
            expect(await readWidgetEntityMovementAdmission(deps, ref, companion, { surface: 'mcp' }))
                .toMatchObject({ status: 'refused' });
            await homeHubArtifacts.apply({ kind: 'widget_inputs', instanceId: instance.id, bindings: instance.bindings });
            expect((await homeHubArtifacts.read()).instances).toEqual([instance, sibling]);
            expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1[key]?.items).toEqual(initial.items);
            const runtime = createEntityDragDropRuntime();
            runtime.registerSource({ id: 'home', scope, isCurrent: () => true, getItem: () => ({ kind: 'home-section', scope, sectionId: instance.id }) });
            runtime.registerTarget({ id: 'companion', scope, isCurrent: () => true, acceptedKinds: ['home-section'], getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
                resolve: () => admitWidgetEntityMovement({ actionId: 'widgets.instance.move', input: { ref, to: { surface: companion, index: 0 } }, preview: { verb: 'Move', target: 'Companion' } }, admission),
                execute: async effect => projectWidgetEntityMovementResult(await executor.execute('widgets.instance.move', effect.input, { surface: 'mcp', bypassApprovals: true }), effect),
            });
            const cancelled = runtime.begin('home', 'keyboard'); cancelled?.choose('companion'); cancelled?.cancel(); await cancelled?.release();
            expect((await homeHubArtifacts.read()).instances).toEqual([instance, sibling]);
            transferring = true;
            await React.act(async () => {
                expect(await runtime.perform('home', 'companion', undefined, 'chooser')).toEqual({ status: 'applied' });
            });
            expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1[key]?.items).toEqual([
                { kind: 'instance', instance, frameStyle: 'plain' }, ...initial.items,
            ]);
            expect((await homeHubArtifacts.read()).instances).toEqual([sibling]);
            const companionRef = { surface: companion, instanceId: instance.id };
            const updateBindings = (bindings: Parameters<typeof setSessionCompanionInstanceInputs>[2]) => React.act(async () => {
                const localSettings = storage.getState().localSettings;
                const updated = LocalSettingsSchema.parse({ ...localSettings, sessionCompanionPreferencesBySessionV1: { ...localSettings.sessionCompanionPreferencesBySessionV1,
                    [key]: setSessionCompanionInstanceInputs(localSettings.sessionCompanionPreferencesBySessionV1[key]!, instance.id, bindings) } });
                storage.getState().applyLocalSettings({ sessionCompanionPreferencesBySessionV1: updated.sessionCompanionPreferencesBySessionV1 });
            });
            await updateBindings({ count: { kind: 'context', slot: 'sessionCount' } });
            expect(await readWidgetEntityMovementAdmission(deps, companionRef, home, { surface: 'mcp' }))
                .toMatchObject({ status: 'refused', code: 'widget_context_missing', ref: companionRef });
            await updateBindings(instance.bindings);
            const homeAdmission = await readWidgetEntityMovementAdmission(deps, companionRef, home, { surface: 'mcp' });
            runtime.registerSource({ id: 'companion-copy', scope, isCurrent: () => true, getItem: () => ({ kind: 'companion-item', scope,
                address: { serverId: scope.serverId, sessionId: 'session-a' }, item: { kind: 'instance', instance } }) });
            runtime.registerTarget({ id: 'home-target', scope, isCurrent: () => true, acceptedKinds: ['companion-item'], getBounds: () => ({ x: 200, y: 0, width: 100, height: 100 }),
                resolve: () => admitWidgetEntityMovement({ actionId: 'widgets.instance.move', input: { ref: companionRef, to: { surface: home, index: 0 } }, preview: { verb: 'Move', target: 'Home' } }, homeAdmission),
                execute: async effect => projectWidgetEntityMovementResult(await executor.execute('widgets.instance.move', effect.input, { surface: 'mcp', bypassApprovals: true }), effect),
            });
            await React.act(async () => {
                const carry = runtime.begin('companion-copy', 'keyboard'); carry?.choose('home-target');
                expect(await carry?.release()).toEqual({ status: 'applied' });
            });
            expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1[key]?.items).toEqual(initial.items);
            expect((await homeHubArtifacts.read()).instances).toEqual(expect.arrayContaining([instance, sibling]));
            await React.act(async () => {
                const carry = runtime.begin('home', 'pointer'); carry?.move({ x: 10, y: 10 });
                expect(await carry?.release()).toEqual({ status: 'applied' });
            });
            expect((await homeHubArtifacts.read()).instances).toEqual([sibling]);
            expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1[key]?.items).toEqual([{ kind: 'instance', instance, frameStyle: 'plain' }, ...initial.items]);
            await React.act(async () => {
                expect(await executor.execute('widgets.instance.move', { ref: companionRef, to: { surface: home, index: 0 } }, { surface: 'mcp', bypassApprovals: true }))
                    .toMatchObject({ ok: true, result: { ref, fromRef: companionRef, status: 'moved' } });
            });
            expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1[key]?.items).toEqual(initial.items);
            expect((await homeHubArtifacts.read()).instances.filter(copy => copy.id === instance.id)).toEqual([instance]);
        } finally { await renderer.unmount(); storage.setState(previous, true); }
    });
    it('captures a framed transfer through the actual mounted producer and refuses cleanup after a newer edit', async () => {
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'viewer-a' };
        const surface = { ...scope, owner: { kind: 'companion' as const, sessionId: 'session-a' } };
        const key = buildRealmQualifiedSessionCompanionPreferenceKey(scope, 'session-a');
        if (!key) throw new Error('Expected a qualified Companion preference key');
        const instance = { v: 1 as const, id: 'copy-a', definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: {} };
        const initial = normalizeSessionCompanionPreference({ v: 1, visible: true, collapsed: false, edge: 'trailing', density: 'compact',
            items: [{ kind: 'builtin', id: 'session_summary' }, { kind: 'widget', widgetId: 'shared' }] });
        const previous = storage.getState();
        storage.setState({ profileScope: scope, localSettings: LocalSettingsSchema.parse({ ...localSettingsDefaults, sessionCompanionPreferencesBySessionV1: { [key]: initial } }) });
        const renderer = await renderScreen(React.createElement(SessionPresentedSurfacePresentationTarget, {
            sessionId: 'session-a', serverId: scope.serverId, presented: true,
            openBoard: () => ({ status: 'unchanged' as const }), revealBoardItem: () => ({ status: 'unchanged' as const }),
            returnToChat: () => ({ status: 'unchanged' as const }), openFullSurface: () => ({ status: 'unchanged' as const }),
        }));
        try {
            const port = createWidgetCompanionActionDepsV1({ ...scope, accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) }, assertCurrent() {} }).widgetSurfaceActions?.companion;
            if (!port) throw new Error('Expected the Companion surface port');
            const acknowledged: { value: ActionExecuteResult | null } = { value: null };
            await React.act(async () => {
                const pending = port.apply(surface, { kind: 'add', instance, position: { index: 0 }, presentation: { frameStyle: 'plain' }, captureForMove: true }, {});
                // The native producer already committed synchronously, but the
                // async surface acknowledgement has not returned to the mover.
                const state = storage.getState();
                const edited = setSessionCompanionInstanceInputs(normalizeSessionCompanionPreference(state.localSettings.sessionCompanionPreferencesBySessionV1[key]), instance.id,
                    { label: { kind: 'value', value: 'A newer choice' } });
                storage.setState({ localSettings: LocalSettingsSchema.parse({ ...state.localSettings, sessionCompanionPreferencesBySessionV1: { [key]: edited } }) });
                acknowledged.value = await pending;
            });
            const added = acknowledged.value;
            expect(added).toMatchObject({ ok: true, result: { moveCapture: { expectedInstance: instance,
                expectedPresentation: { frameStyle: 'plain', nativeIndex: 0 } } } });
            if (!added?.ok) throw new Error('Expected the transfer addition');
            if (!added.result || typeof added.result !== 'object' || Array.isArray(added.result)) throw new Error('Expected the transfer result');
            const capture = WidgetMoveCaptureV1Schema.parse(Reflect.get(added.result, 'moveCapture'));
            await React.act(async () => {
                expect(await port.apply(surface, { kind: 'remove', instanceId: instance.id, ...capture }, {})).toMatchObject({ ok: false, errorCode: 'widgets_move_conflict' });
            });
            expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1[key]?.items).toEqual([
                { kind: 'instance', instance: { ...instance, bindings: { label: { kind: 'value', value: 'A newer choice' } } }, frameStyle: 'plain' }, ...initial.items,
            ]);
            const fresh = WidgetMoveCaptureV1Schema.parse(await port.captureMove?.(surface, instance.id, {}));
            expect(fresh.expectedPresentation).toEqual({ frameStyle: 'plain', nativeIndex: 0 });
            await React.act(async () => {
                expect(await port.apply(surface, { kind: 'remove', instanceId: instance.id, ...fresh }, {})).toMatchObject({ ok: true });
            });
            expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1[key]?.items).toEqual(initial.items);
        } finally { await renderer.unmount(); storage.setState(previous, true); }
    });
    it('borrows the existing mounted personal writer and becomes unavailable when that owner unmounts', async () => {
        const scope = { serverId: 'home-a', accountId: 'viewer-a' };
        const surface = { ...scope, owner: { kind: 'companion' as const, sessionId: 'session-a' } };
        const key = buildRealmQualifiedSessionCompanionPreferenceKey(scope, 'session-a');
        if (!key) throw new Error('Expected a qualified Companion preference key');
        const instance = { v: 1 as const, id: 'copy-a', definition: { kind: 'installed' as const, surface: { pluginId: 'acme.metrics', localId: 'status' } }, bindings: {} };
        const initial = normalizeSessionCompanionPreference({ v: 1, visible: true, collapsed: false, edge: 'trailing', density: 'compact', items: [{ kind: 'widget', widgetId: 'shared' }, { kind: 'instance', instance }] });
        const previous = storage.getState();
        storage.setState({ profileScope: scope, localSettings: LocalSettingsSchema.parse({ ...localSettingsDefaults, sessionCompanionPreferencesBySessionV1: { [key]: initial } }) });
        const deps = createWidgetCompanionActionDepsV1({ ...scope, accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) }, assertCurrent() {} });
        const port = deps.widgetSurfaceActions?.companion;
        expect(port).toBeDefined();
        expect(await port!.read(surface, {})).toMatchObject({ ok: false, errorCode: 'widgets_surface_unavailable' });
        const dispose = registerSessionPresentationOnlyTarget({ serverId: 'home-a', sessionId: 'session-a' }, {
            isCurrent: () => true,
            applySessionPresentationIntent: intent => {
                if (intent.kind !== 'companion.instance.inputs.set') return { status: 'invalidTarget' };
                const state = storage.getState();
                const preference = normalizeSessionCompanionPreference(state.localSettings.sessionCompanionPreferencesBySessionV1[key]);
                const next = setSessionCompanionInstanceInputs(preference, intent.instanceId, intent.bindings);
                storage.setState({ localSettings: LocalSettingsSchema.parse({ ...state.localSettings, sessionCompanionPreferencesBySessionV1: { [key]: next } }) });
                return { status: 'applied' };
            },
        });
        try {
            expect(await port!.read(surface, {})).toMatchObject({ instances: [{ instance }] });
            expect(await port!.apply(surface, { kind: 'inputs', instanceId: instance.id, bindings: { label: { kind: 'value', value: 'Personal choice' } } }, {}))
                .toMatchObject({ ok: true, result: { instance: { bindings: { label: { kind: 'value', value: 'Personal choice' } } } } });
            expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1[key]?.items[0]).toEqual({ kind: 'widget', widgetId: 'shared' });
        } finally { dispose(); storage.setState(previous, true); }
        expect(await port!.read(surface, {})).toMatchObject({ ok: false, errorCode: 'widgets_surface_unavailable' });
    });
});

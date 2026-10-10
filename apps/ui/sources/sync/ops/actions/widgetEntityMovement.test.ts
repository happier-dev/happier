import { describe, expect, it, vi } from 'vitest';
import type { EntityDropEffectV1 } from '@happier-dev/protocol/plugins/ui';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { admitWidgetEntityMovement, projectWidgetEntityMovementResult, widgetMovementRefused } from './widgetEntityMovement';
import { resolveSessionSurfaceIndicatorEdge } from '@/components/sessions/board/sessionSurfaceIndicatorEdge';
import { resolveSessionSurfaceKeyboardRoute } from '@/components/sessions/board/sessionSurfaceKeyboardDestination';
import type { EntityDropDestination } from '@/components/ui/treeDragDrop';
import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { describeEntityDropOutcome } from '@/components/ui/treeDragDrop/ui/entityDropOutcome';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { HOME_HUB_DEFAULT_LAYOUT } from '@happier-dev/protocol/home';
import type { WidgetLayoutGroupV1 } from '@happier-dev/protocol/widgets';

installDisconnectedServerSocketBoundary();

const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'account' };
const fromRef = { surface: { ...scope, owner: { kind: 'home' as const } }, instanceId: 'copy' };
const toRef = { surface: { ...scope, owner: { kind: 'companion' as const, sessionId: 'session' } }, instanceId: 'copy' };
const instance = { v: 1 as const, id: 'copy', definition: { kind: 'builtin' as const, id: 'changes' }, bindings: {} };
const effect: EntityDropEffectV1 = { actionId: 'widgets.item.move', input: { ref: fromRef, to: { surface: toRef.surface, index: 0 } }, preview: { verb: 'Move', target: 'Companion', glyph: 'move' } };

describe('widget movement Action recovery projection', () => {
    it('reads whole groups and saved child presentation from the real Home owner without mutating the Artifact', async () => {
        const previous = storage.getState();
        const boundary = createHomeHubArtifactHttpBoundary(scope.accountId);
        const group: WidgetLayoutGroupV1 = { kind: 'group', id: 'group', width: 'half', frameStyle: 'card', dividers: 'hairline',
            children: [{ kind: 'widget', instance, size: 'small', frameStyle: 'plain' }] };
        boundary.seed({ ...HOME_HUB_DEFAULT_LAYOUT, items: [group] });
        await import('@/sync/syncEngine');
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://widget-group-admission.test', accountId: scope.accountId, request: boundary.request });
        try {
            const currentScope = { ...scope, serverId: connection.home.id };
            storage.setState({ profileScope: currentScope });
            const surface = { ...currentScope, owner: { kind: 'home' as const } };
            const { readDefaultWidgetMovementAdmission } = await import('./defaultActionExecutor');
            expect(await readDefaultWidgetMovementAdmission({ surface, instanceId: group.id }, surface))
                .toEqual({ status: 'ready', ref: { surface, instanceId: group.id }, instance: null, sourceItem: group, destination: surface });
            expect(await readDefaultWidgetMovementAdmission({ surface, instanceId: instance.id }, surface))
                .toMatchObject({ status: 'ready', instance, sourceItem: group.children[0] });
            // Admit a real, source-free Project surface before testing the group transfer restriction.
            const destination = { ...currentScope, owner: { kind: 'project' as const, projectId: 'another-project' } };
            expect(await readDefaultWidgetMovementAdmission({ surface, instanceId: group.id }, destination))
                .toMatchObject({ status: 'refused', code: 'unsupported_widget_transfer' });
            expect(boundary.writes).toEqual([]);
        } finally { await connection.dispose(); storage.setState(previous, true); }
    });
    it('the shared pointer preview describes a widget transfer as movement, not as an addition', () => {
        expect(describeEntityDropOutcome({ phase: 'carrying', admission: { status: 'allowed', effect } }))
            .toMatchObject({ glyph: 'move', title: effect.preview.verb });
    });
    it('retains owner-provided recovery content in Details only for its current Account', async () => {
        const previous = storage.getState();
        const boundary = createHomeHubArtifactHttpBoundary(scope.accountId);
        await import('@/sync/syncEngine');
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://widget-recovery.test', accountId: scope.accountId, request: boundary.request });
        const alert = vi.spyOn(Modal, 'alert').mockImplementation(() => {});
        try {
            const currentScope = { ...scope, serverId: connection.home.id };
            const currentFromRef = { ...fromRef, surface: { ...fromRef.surface, ...currentScope } };
            const currentToRef = { ...toRef, surface: { ...toRef.surface, ...currentScope } };
            const currentEffect = { ...effect, input: { ref: currentFromRef, to: { surface: currentToRef.surface, index: 0 } } };
            storage.setState({ profileScope: currentScope });
            projectWidgetEntityMovementResult({ ok: false, errorCode: 'widget_transfer_refused', error: 'widget_transfer_refused', details: {
                fromRef: currentFromRef, toRef: currentToRef, phase: 'compensation', source: 'absent', destination: 'absent', reasonCode: 'widget_instance_changed', instance,
            } }, currentEffect);
            readPresentationNotice()?.undo?.run();
            expect(alert.mock.calls[0]?.[1]).toContain('"id": "copy"');
            storage.setState({ profileScope: { ...currentScope, accountId: 'another-account' } });
            readPresentationNotice()?.undo?.run();
            expect(alert.mock.calls[1]?.[1]).not.toContain(instance.id);
        } finally { alert.mockRestore(); await connection.dispose(); storage.setState(previous, true); retirePresentationNotice(); }
    });
    it('lets keyboard surface navigation reach another owner and stays there for placement arrows', () => {
        const destination = (targetId: string, group: string, index: number): EntityDropDestination => ({ targetId, group, destination: { index }, admission: { status: 'allowed', effect } });
        const own = destination('board', 'Board', 0);
        const first = destination('companion', 'Companion', 0);
        const second = destination('companion', 'Companion', 1);
        const home = destination('home', 'Home', 0);
        const input = { destinations: [own, first, second, home], sourceTargetId: 'board', resolveLocal: () => own };
        expect(resolveSessionSurfaceKeyboardRoute({ ...input, selected: own, intent: 'in' })).toBe(first);
        expect(resolveSessionSurfaceKeyboardRoute({ ...input, selected: first, intent: 'next' })).toBe(second);
        expect(resolveSessionSurfaceKeyboardRoute({ ...input, selected: second, intent: 'in' })).toBe(home);
        expect(resolveSessionSurfaceKeyboardRoute({ ...input, selected: home, intent: 'out' })).toBe(first);
        expect(resolveSessionSurfaceKeyboardRoute({ ...input, selected: second, intent: 'next' })).toBeNull();
    });
    it('projects Board keyboard placement against native mixed positions, excluding its source', () => {
        const surface = { ...scope, owner: { kind: 'sessionBoard' as const, sessionId: 'session' } };
        for (const index of [0, 1]) {
            const move: EntityDropEffectV1 = { actionId: 'widgets.item.move', preview: effect.preview,
                input: { ref: { surface, instanceId: 'copy' }, to: { surface, tabId: 'view', index } } };
            expect(resolveSessionSurfaceIndicatorEdge({ effect: move, bounds: null, pointer: null,
                boardTarget: { surface, tabId: 'view', itemId: 'ordinary', itemIds: ['copy', 'ordinary'] } }))
                .toBe(index === 0 ? 'top' : 'bottom');
        }
    });
    it('projects Project-aside keyboard placement against current area order, excluding its source', () => {
        const surface = { ...scope, owner: { kind: 'project' as const, projectId: 'portable-source' } };
        for (const index of [0, 1]) {
            const move: EntityDropEffectV1 = { actionId: 'widgets.item.move', preview: effect.preview,
                input: { ref: { surface, instanceId: 'copy' }, to: { surface, index } } };
            expect(resolveSessionSurfaceIndicatorEdge({ effect: move, bounds: null, pointer: null,
                widgetAreaTarget: { surface, itemId: 'ordinary', itemIds: ['copy', 'ordinary'] } }))
                .toBe(index === 0 ? 'top' : 'bottom');
        }
    });
    it('projects a child reorder only in its target group instead of also highlighting surface rows', () => {
        const surface = fromRef.surface;
        const move: EntityDropEffectV1 = { actionId: 'widgets.item.move', preview: effect.preview,
            input: { ref: { surface, instanceId: 'copy' }, to: { surface, groupId: 'group', index: 1 } } };
        const input = { effect: move, bounds: null, pointer: null };
        expect(resolveSessionSurfaceIndicatorEdge({ ...input, widgetAreaTarget: { surface, itemId: 'ordinary', itemIds: ['copy', 'ordinary'] } })).toBeNull();
        expect(resolveSessionSurfaceIndicatorEdge({ ...input, widgetAreaTarget: { surface, groupId: 'group', itemId: 'ordinary', itemIds: ['copy', 'ordinary'] } })).toBe('bottom');
    });
    it('requires acknowledgement of the exact requested destination rather than any success-shaped widget result', () => {
        expect(projectWidgetEntityMovementResult({ ok: true, result: { ref: fromRef, instance } }, effect).status).toBe('unknown');
        expect(projectWidgetEntityMovementResult({ ok: true, result: { ref: toRef, fromRef, instance, status: 'moved' } }, effect)).toEqual({ status: 'applied' });
    });
    it('accepts an acknowledged whole group only when its item identity matches the requested placement', () => {
        const groupSurface = fromRef.surface;
        const groupRef = { surface: groupSurface, instanceId: 'group' };
        const group = { kind: 'group', id: 'group', width: 'half', frameStyle: 'card', dividers: 'hairline',
            children: [{ kind: 'widget', instance, size: 'small' }] };
        const groupEffect = { ...effect, input: { ref: groupRef, to: { surface: groupSurface, groupId: null, index: 1 } } };
        expect(projectWidgetEntityMovementResult({ ok: true, result: { ref: groupRef, instance: null, item: group } }, groupEffect)).toEqual({ status: 'applied' });
        expect(projectWidgetEntityMovementResult({ ok: true, result: { ref: groupRef, instance: null, item: { ...group, id: 'another' } } }, groupEffect).status).toBe('unknown');
    });
    it('preserves typed refused versus unknown presence facts in the shared notice without retrying or claiming rollback', () => {
        for (const errorCode of ['widget_transfer_refused', 'widget_transfer_unknown']) {
            const outcome = projectWidgetEntityMovementResult({ ok: false, errorCode, error: errorCode, details: {
                fromRef, toRef, phase: 'source_remove', source: 'present', destination: errorCode.endsWith('unknown') ? 'unknown' : 'absent', reasonCode: 'widget_instance_changed',
            } }, effect);
            expect(outcome).toMatchObject({ status: errorCode.endsWith('unknown') ? 'unknown' : 'refused', reason: { code: errorCode } });
            expect(readPresentationNotice()).toMatchObject({ key: 'widgets.item.move', severity: errorCode.endsWith('unknown') ? 'warning' : 'error' });
        }
        retirePresentationNotice();
    });
});

describe('widget movement refusal words (lab widget-groups wgdnd: reason and the way forward)', () => {
    const carrying = (admission: ReturnType<typeof widgetMovementRefused>) => describeEntityDropOutcome({ phase: 'carrying', admission });
    it('never shows a refusal code to the person, whatever the owner refused with', () => {
        for (const code of ['widget_edit_denied', 'unsupported_widget_transfer', 'unsupported_widget_surface', 'widget_placement_unsupported',
            'widget_instance_already_exists', 'widget_inputs_unavailable', 'widget_destination_unresolved', 'widget_instance_changed',
            'widget_destination_changed', 'widget_instance_not_found', 'widget_group_not_found', 'anchor-gone', 'scope-mismatch',
            'server_target_mismatch', 'account_target_mismatch', 'widget_area_scope_retired', 'invalid_action_output', 'some_future_owner_code']) {
            const outcome = carrying(widgetMovementRefused(code));
            expect(outcome).toMatchObject({ tone: 'refused' });
            expect(outcome?.detail).toBeTruthy();
            expect(outcome?.detail).not.toContain(code);
            expect(outcome?.detail).not.toMatch(/[_()]/);
        }
    });
    it('says different things for a read-only layout, a surface that cannot host it, and a layout that just changed', () => {
        const words = ['widget_edit_denied', 'unsupported_widget_transfer', 'widget_instance_changed', 'widget_instance_already_exists', 'widget_inputs_unavailable']
            .map(code => widgetMovementRefused(code).reason.message);
        expect(new Set(words).size).toBe(words.length);
    });
    it('shows only the carried card over its own position: nothing would change, so nothing is refused', () => {
        expect(carrying(widgetMovementRefused('same-position'))).toBeNull();
    });
    it('shows only the carried card while admission is still being read: pending is not a refusal', () => {
        expect(describeEntityDropOutcome({ phase: 'carrying', admission: admitWidgetEntityMovement(effect, null) })).toBeNull();
    });
});

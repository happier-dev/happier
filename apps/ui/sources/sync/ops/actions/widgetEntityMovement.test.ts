import { describe, expect, it, vi } from 'vitest';
import type { EntityDropEffectV1 } from '@happier-dev/protocol/plugins/ui';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { projectWidgetEntityMovementResult } from './widgetEntityMovement';
import { resolveSessionSurfaceIndicatorEdge } from '@/components/sessions/board/sessionSurfaceIndicatorEdge';
import { resolveSessionSurfaceKeyboardRoute } from '@/components/sessions/board/sessionSurfaceKeyboardDestination';
import type { EntityDropDestination } from '@/components/ui/treeDragDrop';
import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { describeSessionListDropOutcome } from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';

installDisconnectedServerSocketBoundary();

const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'account' };
const fromRef = { surface: { ...scope, owner: { kind: 'home' as const } }, instanceId: 'copy' };
const toRef = { surface: { ...scope, owner: { kind: 'companion' as const, sessionId: 'session' } }, instanceId: 'copy' };
const instance = { v: 1 as const, id: 'copy', definition: { kind: 'builtin' as const, id: 'changes' }, bindings: {} };
const effect: EntityDropEffectV1 = { actionId: 'widgets.instance.move', input: { ref: fromRef, to: { surface: toRef.surface, index: 0 } }, preview: { verb: 'Move', target: 'Companion' } };

describe('widget movement Action recovery projection', () => {
    it('the shared pointer preview describes a widget transfer as movement, not as an addition', () => {
        expect(describeSessionListDropOutcome({ phase: 'carrying', admission: { status: 'allowed', effect } }))
            .toMatchObject({ glyph: 'above', title: effect.preview.verb });
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
            const move: EntityDropEffectV1 = { actionId: 'widgets.instance.move', preview: effect.preview,
                input: { ref: { surface, instanceId: 'copy' }, to: { surface, tabId: 'view', index } } };
            expect(resolveSessionSurfaceIndicatorEdge({ effect: move, bounds: null, pointer: null,
                boardTarget: { surface, tabId: 'view', itemId: 'ordinary', itemIds: ['copy', 'ordinary'] } }))
                .toBe(index === 0 ? 'top' : 'bottom');
        }
    });
    it('requires acknowledgement of the exact requested destination rather than any success-shaped widget result', () => {
        expect(projectWidgetEntityMovementResult({ ok: true, result: { ref: fromRef, instance } }, effect).status).toBe('unknown');
        expect(projectWidgetEntityMovementResult({ ok: true, result: { ref: toRef, fromRef, instance, status: 'moved' } }, effect)).toEqual({ status: 'applied' });
    });
    it('preserves typed refused versus unknown presence facts in the shared notice without retrying or claiming rollback', () => {
        for (const errorCode of ['widget_transfer_refused', 'widget_transfer_unknown']) {
            const outcome = projectWidgetEntityMovementResult({ ok: false, errorCode, error: errorCode, details: {
                fromRef, toRef, phase: 'source_remove', source: 'present', destination: errorCode.endsWith('unknown') ? 'unknown' : 'absent', reasonCode: 'widget_instance_changed',
            } }, effect);
            expect(outcome).toMatchObject({ status: errorCode.endsWith('unknown') ? 'unknown' : 'refused', reason: { code: errorCode } });
            expect(readPresentationNotice()).toMatchObject({ key: 'widgets.instance.move', severity: errorCode.endsWith('unknown') ? 'warning' : 'error' });
        }
        retirePresentationNotice();
    });
});

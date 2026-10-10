import { describe, expect, it, vi } from 'vitest';

import type { CurrentSessionPresentationIntentV1 } from '@happier-dev/protocol/sessions';

import type { PresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import {
    CLOSED_SESSION_VIEWER,
    resolveSessionViewerPresentation,
    type SessionViewerPresentationState,
} from '@/components/sessions/viewer/sessionViewerPresentation';

import {
    HIDDEN_SESSION_COMPANION_PREFERENCE_V1,
    addSessionCompanionItem,
    removeSessionCompanionItem,
    moveSessionCompanionItem,
    setSessionCompanionItemFrameStyle,
    showSessionCompanion,
    setSessionCompanionInstanceInputs,
    renameSessionCompanionInstance,
    type SessionCompanionPreferenceV1,
} from '../state/sessionCompanionPreference';
import type { SessionCompanionController } from '../state/useSessionCompanionController';
import { canAddSessionCompanionItem } from '../sessionCompanionContentModel';
import {
    applySessionCompanionMutationWithNotice,
    applySessionPresentationIntent,
    buildSessionPresentationNoticeKeyPrefix,
    showSessionBoardItemInCompanion,
    type SessionPresentationPorts,
} from './sessionCompanionPresentationAdapter';

function controllerStub(overrides: Partial<SessionCompanionController> = {}): SessionCompanionController {
    let preference: SessionCompanionPreferenceV1 = HIDDEN_SESSION_COMPANION_PREFERENCE_V1;
    const outcome = (next: SessionCompanionPreferenceV1) => {
        if (next === preference) return null;
        const previous = preference;
        preference = next;
        return { previous, applied: next };
    };
    return {
        get preference() { return preference; },
        availability: 'ready',
        preferenceExists: true,
        show: (item) => outcome(showSessionCompanion(preference, item)),
        hide: () => outcome({ ...preference, visible: false }),
        setCollapsed: () => null,
        setEdge: (edge) => outcome({ ...preference, edge }),
        setDensity: () => null,
        setItemFrameStyle: (item, style) => outcome(setSessionCompanionItemFrameStyle(preference, item, style)),
        setInstanceInputs: (instanceId, bindings) => outcome(setSessionCompanionInstanceInputs(preference, instanceId, bindings)),
        renameInstance: (instanceId, displayName) => outcome(renameSessionCompanionInstance(preference, instanceId, displayName)),
        addItem: (item, index) => outcome(addSessionCompanionItem(preference, item, index)),
        removeItem: (item, guard) => outcome(removeSessionCompanionItem(preference, item, guard)),
        moveItem: (item, index) => outcome(moveSessionCompanionItem(preference, item, index)),
        openFullSurface: () => {},
        applyLocalInverse: () => true,
        // The realm-qualified key the canonical preference owner resolves; a published Undo
        // carries it so it cannot write the next Account's preference.
        realmKey: 'account-a:home-1:session-1',
        ...overrides,
    } as SessionCompanionController;
}

function ports(overrides: Partial<SessionPresentationPorts> = {}): SessionPresentationPorts {
    const readableItem = overrides.board?.canReadItem ?? (() => true);
    return {
        companion: controllerStub(),
        canAddCompanionItem: (item) => canAddSessionCompanionItem(item, null, readableItem),
        board: {
            availability: 'ready',
            open: () => ({ status: 'applied', undo: () => {} }),
            selectView: () => ({ status: 'applied' }),
            revealItem: () => ({ status: 'applied' }),
            canReadView: () => true,
            canReadItem: () => true,
        },
        returnToChat: () => ({ status: 'applied' }),
        openFullSurface: () => ({ status: 'applied' }),
        publishNotice: () => {},
        noticeKeyPrefix: 'server-a:session-1',
        ...overrides,
    };
}

const intent = (value: CurrentSessionPresentationIntentV1) => value;

describe('applySessionPresentationIntent', () => {
    it('routes semantic viewer operations through the exact mounted viewer owner', () => {
        let state: SessionViewerPresentationState = CLOSED_SESSION_VIEWER;
        const companion = controllerStub();
        const originalCompanion = companion.preference;
        const exactPorts = ports({ companion, viewer: {
            apply: (viewerIntent) => {
                const transition = resolveSessionViewerPresentation(state, viewerIntent, {
                    phone: false, canPresentSource: () => true,
                });
                state = transition.state;
                return transition.result;
            },
        } });
        expect(applySessionPresentationIntent(exactPorts, { kind: 'viewer.open', source: 'computer' })).toEqual({ status: 'applied' });
        expect(state).toMatchObject({ source: 'computer', mode: 'floating' });
        expect(applySessionPresentationIntent(exactPorts, { kind: 'viewer.open', source: 'computer' })).toEqual({ status: 'unchanged' });
        expect(applySessionPresentationIntent(exactPorts, { kind: 'viewer.source.select', source: 'browser' })).toEqual({ status: 'applied' });
        expect(state).toMatchObject({ source: 'browser', mode: 'floating' });
        expect(applySessionPresentationIntent(exactPorts, { kind: 'viewer.expand' })).toEqual({ status: 'applied' });
        expect(state).toMatchObject({ source: 'browser', mode: 'expanded', restore: { mode: 'floating' } });
        expect(applySessionPresentationIntent(exactPorts, { kind: 'viewer.restore' })).toEqual({ status: 'applied' });
        expect(state).toMatchObject({ source: 'browser', mode: 'floating', restore: null });
        expect(applySessionPresentationIntent(exactPorts, { kind: 'viewer.close' })).toEqual({ status: 'applied' });
        expect(state).toMatchObject({ source: 'browser', mode: 'closed' });
        expect(applySessionPresentationIntent(exactPorts, { kind: 'viewer.close' })).toEqual({ status: 'unchanged' });
        expect(companion.preference).toBe(originalCompanion);
    });

    it('reports unavailable without a mounted viewer port', () => {
        const exactPorts = ports();
        for (const viewerIntent of [
            { kind: 'viewer.open', source: 'computer' },
            { kind: 'viewer.source.select', source: 'browser' },
            { kind: 'viewer.expand' }, { kind: 'viewer.restore' }, { kind: 'viewer.close' },
        ] as const) expect(applySessionPresentationIntent(exactPorts, viewerIntent)).toEqual({ status: 'unavailable' });
    });

    it('retains viewer state when the source owner refuses presentation', () => {
        let state: SessionViewerPresentationState = { ...CLOSED_SESSION_VIEWER, source: 'computer', mode: 'floating' };
        const previous = state;
        const exactPorts = ports({ viewer: {
            apply: (viewerIntent) => {
                const transition = resolveSessionViewerPresentation(state, viewerIntent, {
                    phone: false, canPresentSource: (source) => source === 'computer',
                });
                state = transition.state;
                return transition.result;
            },
        } });
        expect(applySessionPresentationIntent(exactPorts, { kind: 'viewer.source.select', source: 'browser' })).toEqual({ status: 'unavailable' });
        expect(state).toBe(previous);
    });
    it('reports a guarded transfer refusal instead of pretending a changed item was removed', () => {
        const companion = controllerStub();
        const instance = { v: 1 as const, id: 'copy-a', definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: {} };
        const item = { kind: 'instance' as const, instance };
        companion.addItem(item);
        companion.setItemFrameStyle(item, 'plain');
        expect(applySessionPresentationIntent(ports({ companion }), { kind: 'companion.item.remove', item,
            expectedInstance: instance, expectedPresentation: { frameStyle: null, nativeIndex: 0 } })).toEqual({ status: 'invalidTarget' });
        expect(companion.preference.items).toEqual([{ ...item, frameStyle: 'plain' }]);
    });
    it('captures the acknowledged addition before a later notice-triggered edit without widening the wire status', () => {
        const companion = controllerStub();
        const instance = { v: 1 as const, id: 'copy-a', definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: {} };
        const item = { kind: 'instance' as const, instance, frameStyle: 'card' as const };
        let committed: SessionCompanionPreferenceV1 | undefined;
        const result = applySessionPresentationIntent(ports({ companion, canAddCompanionItem: () => true,
            publishNotice: () => { companion.renameInstance(instance.id, 'Newer edit'); } }),
            { kind: 'companion.item.add', item }, outcome => { committed = outcome.applied; });
        expect(result).toEqual({ status: 'applied' });
        expect(committed?.items).toEqual([item]);
        expect(companion.preference.items[0]).toMatchObject({ instance: { displayName: 'Newer edit' } });
    });
    it('uses the mounted catalog for additions and permits frame edits/removal of retained unavailable references', () => {
        const companion = controllerStub();
        companion.show();
        const retained = { kind: 'instance' as const, instance: { v: 1 as const, id: 'copy-a', definition: { kind: 'installed' as const, surface: { pluginId: 'acme.review', localId: 'missing' } }, bindings: {} } };
        companion.addItem(retained);
        const owner = ports({ companion });
        expect(applySessionPresentationIntent(owner, { kind: 'companion.item.add', item: { kind: 'pane', paneId: 'not-a-pane' } })).toEqual({ status: 'invalidTarget' });
        expect(applySessionPresentationIntent(owner, { kind: 'companion.item.add', item: { kind: 'pane', paneId: 'git' } })).toEqual({ status: 'applied' });
        expect(applySessionPresentationIntent(owner, { kind: 'companion.item.frameStyle.set', item: retained, frameStyle: 'plain' })).toEqual({ status: 'applied' });
        expect(companion.preference.items).toContainEqual({ ...retained, frameStyle: 'plain' });
        expect(applySessionPresentationIntent(owner, { kind: 'companion.item.remove', item: retained })).toEqual({ status: 'applied' });
        expect(companion.preference.items.some((ref) => ref.kind === 'instance')).toBe(false);
    });
    it('reveals an exact Board item only after its Companion preference mutation applied', () => {
        const order: string[] = [];
        const applied = {
            previous: HIDDEN_SESSION_COMPANION_PREFERENCE_V1,
            applied: showSessionCompanion(HIDDEN_SESSION_COMPANION_PREFERENCE_V1, {
                kind: 'widget',
                widgetId: 'item-1',
            }),
        };
        const companion = controllerStub({
            show: vi.fn(() => {
                order.push('mutate');
                return applied;
            }),
        });
        const revealAfterMutation = vi.fn(() => { order.push('reveal'); });

        expect(showSessionBoardItemInCompanion({
            companion,
            publishNotice: vi.fn(),
            noticeKeyPrefix: 'home-a:session-1',
            itemId: 'item-1',
            revealAfterMutation,
        })).toBe(applied);
        expect(order).toEqual(['mutate', 'reveal']);
        expect(revealAfterMutation).toHaveBeenCalledWith(applied);
    });

    it('does not reveal a Board item when its Companion mutation is unavailable or unchanged', () => {
        const revealAfterMutation = vi.fn();
        const unavailable = controllerStub({ availability: 'realm_unavailable' });
        const unchanged = controllerStub({ show: vi.fn(() => null) });

        expect(showSessionBoardItemInCompanion({
            companion: unavailable,
            publishNotice: vi.fn(),
            noticeKeyPrefix: 'home-a:session-1',
            itemId: 'item-1',
            revealAfterMutation,
        })).toBeNull();
        expect(showSessionBoardItemInCompanion({
            companion: unchanged,
            publishNotice: vi.fn(),
            noticeKeyPrefix: 'home-a:session-1',
            itemId: 'item-1',
            revealAfterMutation,
        })).toBeNull();
        expect(revealAfterMutation).not.toHaveBeenCalled();
    });

    it('gives mounted human controls the same applied-only notice and safe inverse seam', () => {
        const publishNotice = vi.fn();
        const applied = {
            previous: HIDDEN_SESSION_COMPANION_PREFERENCE_V1,
            applied: showSessionCompanion(HIDDEN_SESSION_COMPANION_PREFERENCE_V1),
        };
        const applyLocalInverse = vi.fn(() => true);
        const companion = controllerStub({ show: vi.fn(() => applied), applyLocalInverse });

        expect(applySessionCompanionMutationWithNotice({
            companion,
            publishNotice,
            noticeKeyPrefix: 'home-a:session-1',
            kind: 'companion.show',
            message: 'shown',
            apply: (current) => current.show(),
        })).toBe(applied);
        expect(publishNotice).toHaveBeenCalledTimes(1);
        expect(publishNotice).toHaveBeenCalledWith(expect.objectContaining({
            message: 'shown',
            undo: expect.objectContaining({ label: expect.any(String) }),
        }));

        const notice = publishNotice.mock.calls[0]?.[0] as PresentationNotice;
        notice.undo?.run();
        expect(applyLocalInverse).toHaveBeenCalledWith(applied, 'account-a:home-1:session-1');
    });

    it('publishes nothing when a mounted human mutation is unavailable or unchanged', () => {
        const publishNotice = vi.fn();
        const unavailable = controllerStub({ availability: 'realm_unavailable', hide: vi.fn(() => null) });
        const unchanged = controllerStub({ hide: vi.fn(() => null) });

        expect(applySessionCompanionMutationWithNotice({
            companion: unavailable,
            publishNotice,
            noticeKeyPrefix: 'home-a:session-1',
            kind: 'companion.hide',
            message: 'hidden',
            apply: (current) => current.hide(),
        })).toBeNull();
        expect(unavailable.hide).not.toHaveBeenCalled();
        expect(applySessionCompanionMutationWithNotice({
            companion: unchanged,
            publishNotice,
            noticeKeyPrefix: 'home-a:session-1',
            kind: 'companion.hide',
            message: 'hidden',
            apply: (current) => current.hide(),
        })).toBeNull();
        expect(publishNotice).not.toHaveBeenCalled();
    });

    it('keeps local Companion commands available while this exact Home Board is unavailable', () => {
        const applied = {
            previous: HIDDEN_SESSION_COMPANION_PREFERENCE_V1,
            applied: showSessionCompanion(HIDDEN_SESSION_COMPANION_PREFERENCE_V1),
        };
        const show = vi.fn(() => applied);
        const removeItem = vi.fn(() => applied);
        const moveItem = vi.fn(() => applied);
        const setEdge = vi.fn(() => applied);
        const setCollapsed = vi.fn(() => applied);
        const setDensity = vi.fn(() => applied);
        const openFullSurface = vi.fn(() => ({ status: 'applied' as const }));
        const companion = controllerStub({ show, removeItem, moveItem, setEdge, setCollapsed, setDensity });
        const unavailableBoard = {
            ...ports().board,
            availability: 'unavailable' as const,
            open: () => ({ status: 'unavailable' as const }),
            canReadView: () => false,
            canReadItem: () => false,
        };
        const exactPorts = ports({
            companion,
            board: unavailableBoard,
            openFullSurface,
        });

        expect(applySessionPresentationIntent(exactPorts, intent({ kind: 'companion.show' })))
            .toEqual({ status: 'applied' });
        expect(applySessionPresentationIntent(exactPorts, intent({
            kind: 'companion.item.remove',
            item: { kind: 'widget', widgetId: 'stale-widget' },
        }))).toEqual({ status: 'applied' });
        expect(applySessionPresentationIntent(exactPorts, intent({
            kind: 'companion.item.move',
            item: { kind: 'widget', widgetId: 'stale-widget' },
            toIndex: 0,
        }))).toEqual({ status: 'applied' });
        expect(applySessionPresentationIntent(exactPorts, intent({ kind: 'companion.edge.set', edge: 'leading' })))
            .toEqual({ status: 'applied' });
        expect(applySessionPresentationIntent(exactPorts, intent({ kind: 'companion.collapse.set', collapsed: true })))
            .toEqual({ status: 'applied' });
        expect(applySessionPresentationIntent(exactPorts, intent({ kind: 'companion.density.set', density: 'comfortable' })))
            .toEqual({ status: 'applied' });
        expect(applySessionPresentationIntent(exactPorts, intent({ kind: 'companion.open_full' })))
            .toEqual({ status: 'applied' });

        expect(show).toHaveBeenCalledTimes(1);
        expect(removeItem).toHaveBeenCalledWith({ kind: 'widget', widgetId: 'stale-widget' });
        expect(moveItem).toHaveBeenCalledWith({ kind: 'widget', widgetId: 'stale-widget' }, 0);
        expect(setEdge).toHaveBeenCalledWith('leading');
        expect(setCollapsed).toHaveBeenCalledWith(true);
        expect(setDensity).toHaveBeenCalledWith('comfortable');
        expect(openFullSurface).toHaveBeenCalledTimes(1);

        // Only the operation which introduces shared Board content still needs
        // that content to resolve in the exact current Board repository.
        expect(applySessionPresentationIntent(exactPorts, intent({
            kind: 'companion.item.add',
            item: { kind: 'widget', widgetId: 'missing-widget' },
        }))).toEqual({ status: 'invalidTarget' });

        // The Board destination is not current merely because the pane owner can
        // draw an unavailable shell. Presentation must fail before pane mutation.
        const open = vi.fn(() => ({ status: 'applied' as const }));
        expect(applySessionPresentationIntent(
            ports({ companion, board: { ...unavailableBoard, open } }),
            intent({ kind: 'board.open', mode: 'beside_chat' }),
        )).toEqual({ status: 'unavailable' });
        expect(open).not.toHaveBeenCalled();
    });

    it('keeps delimiter-bearing Home and Session identities distinct in notice replacement keys', () => {
        const left = buildSessionPresentationNoticeKeyPrefix(
            { serverId: 'https://home.example/a', sessionId: 'b:c' },
            'b:c',
        );
        const right = buildSessionPresentationNoticeKeyPrefix(
            { serverId: 'https://home.example/a:b', sessionId: 'c' },
            'c',
        );

        expect(left).not.toBe(right);
    });

    it('refuses to manufacture an unqualified notice identity when the Session address is unavailable', () => {
        expect(buildSessionPresentationNoticeKeyPrefix(null, 'same-id-on-many-homes')).toBeNull();
    });

    it('refuses before applying an intent when its mounted adapter has no exact Session address', () => {
        const show = vi.fn(() => null);
        const publishNotice = vi.fn();

        expect(applySessionPresentationIntent(
            ports({
                companion: controllerStub({ show }),
                publishNotice,
                noticeKeyPrefix: null,
            }),
            intent({ kind: 'companion.show' }),
        )).toEqual({ status: 'unavailable' });
        expect(show).not.toHaveBeenCalled();
        expect(publishNotice).not.toHaveBeenCalled();
    });

    it('routes a Companion intent through the same controller mutation a human gesture uses', () => {
        const companion = controllerStub();
        const result = applySessionPresentationIntent(ports({ companion }), intent({ kind: 'companion.show' }));

        expect(result).toEqual({ status: 'applied' });
        expect(companion.preference.visible).toBe(true);
        expect(companion.preference.items).toEqual([{ kind: 'builtin', id: 'session_summary' }]);
    });

    it('reports a no-op rather than a fake success', () => {
        const companion = controllerStub({ hide: () => null });

        expect(applySessionPresentationIntent(ports({ companion }), intent({ kind: 'companion.hide' })))
            .toEqual({ status: 'unchanged' });
    });

    it('reports realm-unavailable Companion mutations as unavailable rather than unchanged', () => {
        const companion = controllerStub({ availability: 'realm_unavailable', show: vi.fn(() => null) });

        expect(applySessionPresentationIntent(ports({ companion }), intent({ kind: 'companion.show' })))
            .toEqual({ status: 'unavailable' });
        expect(companion.show).not.toHaveBeenCalled();
    });

    it('refuses a realm-unavailable widget mutation before resolving or mutating its target', () => {
        const addItem = vi.fn(() => null);
        const canReadItem = vi.fn(() => false);
        const companion = controllerStub({ availability: 'realm_unavailable', addItem });

        expect(applySessionPresentationIntent(
            ports({ companion, board: { ...ports().board, canReadItem } }),
            intent({ kind: 'companion.item.add', item: { kind: 'widget', widgetId: 'widget-1' } }),
        )).toEqual({ status: 'unavailable' });
        expect(canReadItem).not.toHaveBeenCalled();
        expect(addItem).not.toHaveBeenCalled();
    });

    it.each([
        ['chat.return', { kind: 'chat.return' } as const, { returnToChat: () => ({ status: 'unchanged' as const }) }],
        ['board.open', { kind: 'board.open', mode: 'beside_chat' } as const, {
            board: { ...ports().board, open: () => ({ status: 'unchanged' as const }) },
        }],
        ['board.view.select', { kind: 'board.view.select', viewId: 'view-1' } as const, {
            board: { ...ports().board, selectView: () => ({ status: 'unchanged' as const }) },
        }],
        ['board.item.reveal', { kind: 'board.item.reveal', widgetId: 'widget-1' } as const, {
            board: { ...ports().board, revealItem: () => ({ status: 'unchanged' as const }) },
        }],
        ['companion.open_full', { kind: 'companion.open_full' } as const, {
            openFullSurface: () => ({ status: 'unchanged' as const }),
        }],
    ])('reports equivalent %s navigation as unchanged without publishing feedback', (_label, command, override) => {
        const publishNotice = vi.fn();

        expect(applySessionPresentationIntent(ports({ ...override, publishNotice }), intent(command)))
            .toEqual({ status: 'unchanged' });
        expect(publishNotice).not.toHaveBeenCalled();
    });

    it.each([
        ['chat.return', { kind: 'chat.return' } as const],
        ['board.view.select', { kind: 'board.view.select', viewId: 'view-1' } as const],
        ['board.item.reveal', { kind: 'board.item.reveal', widgetId: 'widget-1' } as const],
        ['companion.open_full', { kind: 'companion.open_full' } as const],
    ])('publishes one notice after an applied %s navigation', (_label, command) => {
        const publishNotice = vi.fn();

        expect(applySessionPresentationIntent(ports({ publishNotice }), intent(command)))
            .toEqual({ status: 'applied' });
        expect(publishNotice).toHaveBeenCalledTimes(1);
    });

    it('refuses to add a widget this viewer cannot currently read', () => {
        const companion = controllerStub({ addItem: vi.fn(() => null) });
        const result = applySessionPresentationIntent(
            ports({ companion, board: { ...ports().board, canReadItem: () => false } }),
            intent({ kind: 'companion.item.add', item: { kind: 'widget', widgetId: 'w1' } }),
        );

        expect(result).toEqual({ status: 'invalidTarget' });
        expect(companion.addItem).not.toHaveBeenCalled();
    });

    it('refuses a Board view the current repository does not resolve', () => {
        expect(applySessionPresentationIntent(
            ports({ board: { ...ports().board, canReadView: () => false } }),
            intent({ kind: 'board.view.select', viewId: 'missing' }),
        )).toEqual({ status: 'invalidTarget' });
    });

    it('validates an item against the exact requested Board view before revealing it', () => {
        const revealItem = vi.fn(() => ({ status: 'applied' as const }));
        const canReadItem = vi.fn((_widgetId: string, viewId?: string) => viewId !== 'other-view');

        expect(applySessionPresentationIntent(
            ports({ board: { ...ports().board, revealItem, canReadItem } }),
            intent({ kind: 'board.item.reveal', widgetId: 'item-1', viewId: 'other-view' }),
        )).toEqual({ status: 'invalidTarget' });
        expect(canReadItem).toHaveBeenCalledWith('item-1', 'other-view');
        expect(revealItem).not.toHaveBeenCalled();
    });

    it('offers the applying controller safe local inverse for Companion and Board presentation changes', () => {
        const notices: PresentationNotice[] = [];
        const publishNotice = (notice: PresentationNotice) => { notices.push(notice); };
        const undoBoardOpen = vi.fn();

        applySessionPresentationIntent(ports({ publishNotice }), intent({ kind: 'companion.show' }));
        applySessionPresentationIntent(ports({
            publishNotice,
            board: {
                ...ports().board,
                open: () => ({ status: 'applied', undo: undoBoardOpen }),
            },
        }), intent({ kind: 'board.open', mode: 'beside_chat' }));

        expect(notices).toHaveLength(2);
        expect(notices[0]?.undo).toBeDefined();
        notices[1]?.undo?.run();
        expect(undoBoardOpen).toHaveBeenCalledTimes(1);
    });

    it('binds each notice to the exact Account/Home/Session so a replaced notice retires exactly', () => {
        const notices: PresentationNotice[] = [];
        applySessionPresentationIntent(
            ports({ publishNotice: (notice) => { notices.push(notice); }, noticeKeyPrefix: 'home-b:session-9' }),
            intent({ kind: 'companion.show' }),
        );

        expect(notices[0]?.key.startsWith('session-presentation:home-b:session-9:')).toBe(true);
    });

    it('runs the inverse through the controller, which refuses when a newer manual change won', () => {
        const applyLocalInverse = vi.fn(() => false);
        const notices: PresentationNotice[] = [];
        applySessionPresentationIntent(
            ports({
                companion: controllerStub({ applyLocalInverse }),
                publishNotice: (notice) => { notices.push(notice); },
            }),
            intent({ kind: 'companion.edge.set', edge: 'leading' }),
        );

        notices[0]?.undo?.run();
        expect(applyLocalInverse).toHaveBeenCalledTimes(1);
    });

    it('reports an unavailable port instead of silently discarding the command', () => {
        expect(applySessionPresentationIntent(
            ports({ returnToChat: () => ({ status: 'unavailable' }) }),
            intent({ kind: 'chat.return' }),
        )).toEqual({ status: 'unavailable' });
    });

    it.each([
        ['board.view.select', { kind: 'board.view.select', viewId: 'view-1' } as const, {
            board: { ...ports().board, selectView: () => ({ status: 'unavailable' as const }) },
        }],
        ['board.item.reveal', { kind: 'board.item.reveal', widgetId: 'widget-1' } as const, {
            board: { ...ports().board, revealItem: () => ({ status: 'unavailable' as const }) },
        }],
        ['companion.open_full', { kind: 'companion.open_full' } as const, {
            openFullSurface: () => ({ status: 'unavailable' as const }),
        }],
    ])('reports unsuccessful %s navigation as unavailable without feedback', (_label, command, override) => {
        const publishNotice = vi.fn();

        expect(applySessionPresentationIntent(ports({ ...override, publishNotice }), intent(command)))
            .toEqual({ status: 'unavailable' });
        expect(publishNotice).not.toHaveBeenCalled();
    });

    it('does not acknowledge or announce a Board open until the mounted Board port is ready', () => {
        const publishNotice = vi.fn();
        const open = vi.fn(() => ({ status: 'unavailable' as const }));

        expect(applySessionPresentationIntent(
            ports({ board: { ...ports().board, availability: 'unavailable', open }, publishNotice }),
            intent({ kind: 'board.open', mode: 'focus' }),
        )).toEqual({ status: 'unavailable' });
        expect(open).not.toHaveBeenCalled();
        expect(publishNotice).not.toHaveBeenCalled();
    });

    it('does not publish a notice for a refused or unchanged intent', () => {
        const notices: PresentationNotice[] = [];
        const publishNotice = (notice: PresentationNotice) => { notices.push(notice); };
        applySessionPresentationIntent(
            ports({ publishNotice, board: { ...ports().board, canReadItem: () => false } }),
            intent({ kind: 'board.item.reveal', widgetId: 'w1' }),
        );
        applySessionPresentationIntent(
            ports({ publishNotice, companion: controllerStub({ hide: () => null }) }),
            intent({ kind: 'companion.hide' }),
        );

        expect(notices).toEqual([]);
    });
});

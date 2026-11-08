import { describe, expect, it } from 'vitest';

import { resolveSessionCompanionLocalInverse } from './useSessionCompanionController';
import { HIDDEN_SESSION_COMPANION_PREFERENCE_V1, addSessionCompanionItem, moveSessionCompanionItem, removeSessionCompanionItem, setSessionCompanionItemFrameStyle } from './sessionCompanionPreference';

describe('resolveSessionCompanionLocalInverse', () => {
    it('undoes only the changed item frame while preserving later order and neighboring frame edits', () => {
        const summary = { kind: 'builtin' as const, id: 'session_summary' as const };
        const plan = { kind: 'builtin' as const, id: 'agent_plan' as const };
        // A Companion holding the Summary, then the Plan (the inverse rule, not the default composition).
        const previous = addSessionCompanionItem({ ...HIDDEN_SESSION_COMPANION_PREFERENCE_V1, visible: true, items: [summary] }, plan);
        const applied = setSessionCompanionItemFrameStyle(previous, summary, 'card');
        const current = moveSessionCompanionItem(setSessionCompanionItemFrameStyle(applied, plan, 'plain'), plan, 0);
        const restored = resolveSessionCompanionLocalInverse({ previous, applied, itemMutation: { kind: 'frameStyle', item: summary } }, current);
        expect(restored?.items).toEqual([{ ...plan, frameStyle: 'plain' }, summary]);
        expect(resolveSessionCompanionLocalInverse({ previous, applied, itemMutation: { kind: 'frameStyle', item: summary } }, setSessionCompanionItemFrameStyle(current, summary, 'plain'))).toBeNull();
        expect(resolveSessionCompanionLocalInverse({ previous, applied, itemMutation: { kind: 'frameStyle', item: summary } }, removeSessionCompanionItem(current, summary))).toBeNull();
    });

    it('keeps a later frame choice when undoing an item move', () => {
        const summary = { kind: 'builtin' as const, id: 'session_summary' as const };
        const plan = { kind: 'builtin' as const, id: 'agent_plan' as const };
        // A Companion holding the Summary, then the Plan (the inverse rule, not the default composition).
        const previous = addSessionCompanionItem({ ...HIDDEN_SESSION_COMPANION_PREFERENCE_V1, visible: true, items: [summary] }, plan);
        const applied = moveSessionCompanionItem(previous, plan, 0);
        const current = setSessionCompanionItemFrameStyle(applied, plan, 'card');
        expect(resolveSessionCompanionLocalInverse({ previous, applied, itemMutation: { kind: 'moved', item: plan } }, current)?.items)
            .toEqual([summary, { ...plan, frameStyle: 'card' }]);
    });
    it('restores only the fields changed by the original mutation and preserves unrelated newer choices', () => {
        const previous = {
            v: 1 as const,
            visible: false,
            collapsed: false,
            edge: 'trailing' as const,
            density: 'compact' as const,
            items: [] as const,
        };
        const applied = {
            ...previous,
            visible: true,
            items: [{ kind: 'builtin' as const, id: 'session_summary' as const }],
        };

        expect(resolveSessionCompanionLocalInverse({
            previous,
            applied,
        }, {
            ...applied,
            density: 'comfortable',
        })).toEqual({
            ...previous,
            density: 'comfortable',
        });
    });

    it('refuses a stale inverse when a field changed by the original mutation changed again', () => {
        const previous = {
            v: 1 as const,
            visible: true,
            collapsed: false,
            edge: 'trailing' as const,
            density: 'compact' as const,
            items: [{ kind: 'builtin' as const, id: 'session_summary' as const }],
        };
        const applied = { ...previous, edge: 'leading' as const };

        expect(resolveSessionCompanionLocalInverse({ previous, applied }, {
            ...applied,
            edge: 'trailing',
        })).toBeNull();
    });

    it('undoes an exact Summary addition while preserving an unrelated later widget addition', () => {
        const previous = {
            v: 1 as const,
            visible: false,
            collapsed: false,
            edge: 'trailing' as const,
            density: 'compact' as const,
            items: [] as const,
        };
        const applied = {
            ...previous,
            visible: true,
            items: [{ kind: 'builtin' as const, id: 'session_summary' as const }],
        };

        expect(resolveSessionCompanionLocalInverse({
            previous,
            applied,
            itemMutation: {
                kind: 'added',
                item: { kind: 'builtin', id: 'session_summary' },
            },
        }, {
            ...applied,
            density: 'comfortable',
            items: [
                { kind: 'builtin', id: 'session_summary' },
                { kind: 'widget', widgetId: 'later-widget' },
            ],
        })).toEqual({
            ...previous,
            density: 'comfortable',
            items: [{ kind: 'widget', widgetId: 'later-widget' }],
        });
    });

    it('undoes an exact item reorder without discarding an unrelated later item', () => {
        const summary = { kind: 'builtin' as const, id: 'session_summary' as const };
        const moved = { kind: 'widget' as const, widgetId: 'moved-widget' };
        const later = { kind: 'widget' as const, widgetId: 'later-widget' };
        const previous = {
            v: 1 as const,
            visible: true,
            collapsed: false,
            edge: 'trailing' as const,
            density: 'compact' as const,
            items: [summary, moved],
        };
        const applied = { ...previous, items: [moved, summary] };

        expect(resolveSessionCompanionLocalInverse({
            previous,
            applied,
            itemMutation: { kind: 'moved', item: moved },
        }, {
            ...applied,
            items: [moved, later, summary],
        })).toEqual({
            ...previous,
            items: [later, summary, moved],
        });
    });

    it('refuses an exact-item inverse after that same item changed again', () => {
        const summary = { kind: 'builtin' as const, id: 'session_summary' as const };
        const moved = { kind: 'widget' as const, widgetId: 'moved-widget' };
        const previous = {
            v: 1 as const,
            visible: true,
            collapsed: false,
            edge: 'trailing' as const,
            density: 'compact' as const,
            items: [summary, moved],
        };
        const applied = { ...previous, items: [moved, summary] };

        expect(resolveSessionCompanionLocalInverse({
            previous,
            applied,
            itemMutation: { kind: 'moved', item: moved },
        }, previous)).toBeNull();
    });
});

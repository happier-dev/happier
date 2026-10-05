import { describe, expect, it } from 'vitest';
import { EntityDropAdmissionV1Schema, type EntityDropAdmissionV1, type EntityDropEffectV1 } from '@happier-dev/protocol/plugins/ui';

import { describePaneDropOutcome, presentPaneDropAdmission, resolvePaneDropStripCue, type PaneDropScene } from './paneDropPresentation';

const placeholder = { verb: 'Open', target: 'Tabs' };
const tabs: Readonly<Record<string, { paneId: string; title: string }>> = {
    review: { paneId: 'right', title: 'Review #2481' },
    fix: { paneId: 'left', title: 'Fix settings modal remount' },
};
const scene = (over: Partial<PaneDropScene> = {}): PaneDropScene => ({
    paneId: 'right', paneTitle: 'Review #2481', locateTab: id => tabs[id] ?? null, ...over,
});
const allowed = (actionId: string, input: EntityDropEffectV1['input']): EntityDropAdmissionV1 => ({
    status: 'allowed', effect: { actionId, input, preview: placeholder },
});
const carrying = (admission: EntityDropAdmissionV1, targetId = 'center:right') =>
    ({ phase: 'carrying' as const, targetId, admission });

describe('pane drop presentation (lab C2)', () => {
    it('words a centre drop as a kept tab next to the pane’s open tab, and says when edges were declined', () => {
        const open = allowed('workspace.tabs.open', { href: '/s/relay', groupId: 'right', mode: 'newTab', beforeTabId: null });
        const worded = presentPaneDropAdmission(open, scene());
        expect(describePaneDropOutcome({ phase: 'carrying', admission: worded })).toEqual({
            tone: 'allowed', glyph: 'tab', title: 'Open here as a tab', detail: 'Next to Review #2481 · nothing closes',
        });
        const narrow = presentPaneDropAdmission(open, scene({ declinedSplit: true }));
        expect(describePaneDropOutcome({ phase: 'carrying', admission: narrow })?.detail).toBe('This pane is too narrow to split');
        // The Action and its input are the owner's; only the words change.
        expect(worded.status === 'allowed' && worded.effect.input).toEqual(open.status === 'allowed' && open.effect.input);
    });

    it('words an edge as a split in that direction, beside the pane’s open tab', () => {
        const right = presentPaneDropAdmission(allowed('session.canvas.tabs.open', { sessionId: 'relay', leafId: 'right', placement: 'right' }), scene());
        expect(describePaneDropOutcome({ phase: 'carrying', admission: right })).toEqual({
            tone: 'allowed', glyph: 'split', title: 'Split right', detail: 'Opens beside Review #2481',
        });
        const down = presentPaneDropAdmission(allowed('workspace.split', { tabId: 'fix', groupId: 'right', direction: 'down' }), scene());
        expect(describePaneDropOutcome({ phase: 'carrying', admission: down })).toMatchObject({
            glyph: 'splitVertical', title: 'Split down', detail: 'Moves beside Review #2481',
        });
    });

    it('turns an already-open item into Go to, naming where it is, and rings that tab in its own strip only', () => {
        const goTo = presentPaneDropAdmission(allowed('workspace.tabs.activate', { tabId: 'fix' }), scene());
        expect(describePaneDropOutcome({ phase: 'carrying', admission: goTo })).toEqual({
            tone: 'allowed', glyph: 'goTo', title: 'Go to Fix settings modal remount',
            detail: 'Already open in another pane · nothing new opens',
        });
        expect(resolvePaneDropStripCue(carrying(goTo), { targetIds: ['center:left'], tabIds: ['fix'] }))
            .toEqual({ slot: false, pulseTabKey: 'fix' });
        expect(resolvePaneDropStripCue(carrying(goTo), { targetIds: ['center:right'], tabIds: ['review'] }))
            .toEqual({ slot: false, pulseTabKey: null });
    });

    it('says Already here quietly for a tab over its own pane, and keeps other refusals as refusals', () => {
        const same = presentPaneDropAdmission({ status: 'refused', reason: { code: 'workspace_tab_already_here', message: 'x' } }, scene());
        expect(describePaneDropOutcome({ phase: 'carrying', admission: same })).toEqual({
            tone: 'quiet', glyph: 'here', title: 'Already here', detail: 'Release to leave it where it is',
        });
        const kind = presentPaneDropAdmission({ status: 'refused', reason: { code: 'canvas_kind_unsupported', message: 'x' } }, scene({ sessionsOnly: true }));
        expect(kind).toMatchObject({ status: 'refused', reason: { message: 'This pane shows sessions only' }, preview: { verb: 'Can’t open it here' } });
        // Another owner words its own refusal.
        expect(describePaneDropOutcome({ phase: 'carrying', admission: kind })).toBeNull();
    });

    it('completes wordless pane decisions into the strict portable contract, including sole-tab refusals', () => {
        const effect = { actionId: 'workspace.tabs.open', input: { href: '/inbox', groupId: 'right', mode: 'newTab' } };
        const open = presentPaneDropAdmission({ status: 'allowed', effect }, scene());
        expect(EntityDropAdmissionV1Schema.safeParse(open).success).toBe(true);
        expect(open.status === 'allowed' && open.effect.input).toBe(effect.input);
        expect(describePaneDropOutcome({ phase: 'carrying', admission: open })).toMatchObject({ tone: 'allowed', glyph: 'tab' });
        for (const code of ['workspace_tab_cannot_split_own_pane', 'canvas_tab_cannot_split_own_pane']) {
            const refusal = presentPaneDropAdmission({ status: 'refused', reason: { code } }, scene());
            expect(EntityDropAdmissionV1Schema.safeParse(refusal).success).toBe(true);
            expect(describePaneDropOutcome({ phase: 'carrying', admission: refusal })).toMatchObject({ tone: 'quiet', glyph: 'here' });
        }
    });

    it('shows a ghost slot only where an unanchored kept tab lands, and words anchored strip drops by their anchor', () => {
        const open = presentPaneDropAdmission(allowed('workspace.tabs.open', { href: '/x', groupId: 'right', mode: 'newTab', beforeTabId: null }), scene());
        expect(resolvePaneDropStripCue(carrying(open), { targetIds: ['center:right', 'strip:right'], tabIds: ['review'] }))
            .toEqual({ slot: true, pulseTabKey: null });
        expect(resolvePaneDropStripCue(carrying(open, 'center:left'), { targetIds: ['center:right'], tabIds: ['review'] }).slot).toBe(false);
        const anchored = presentPaneDropAdmission(allowed('workspace.tabs.reorder', { tabId: 'fix', beforeTabId: 'review' }), scene({ beforeTabId: 'review' }));
        expect(describePaneDropOutcome({ phase: 'carrying', admission: anchored })).toMatchObject({
            title: 'Move before Review #2481', detail: 'Only its place changes',
        });
        expect(resolvePaneDropStripCue(carrying(anchored, 'strip:right'), { targetIds: ['strip:right'], tabIds: ['review', 'fix'] }).slot).toBe(false);
    });

    it('leaves effects it does not own to their owner', () => {
        const relation = allowed('session.reports_to.set', { sessionId: 'a', leadSessionId: 'b' });
        expect(presentPaneDropAdmission(relation, scene())).toBe(relation);
        expect(describePaneDropOutcome({ phase: 'carrying', admission: relation })).toBeNull();
    });
});

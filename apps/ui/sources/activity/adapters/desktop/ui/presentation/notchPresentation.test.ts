import { describe, expect, it } from 'vitest';

import { createNotchPresentation, notchPresentationDelay, reduceNotchPresentation, type NotchPresentationFacts } from './notchPresentation';

const facts: NotchPresentationFacts = {
    enabled: true, visible: false, idle: 'tip', cameraNotch: true,
    hoverExpandDelayMs: 1000, draftLocked: false, focusWithin: false, blockingCard: false,
};

describe('notch presentation owner', () => {
    it('opens collapsed content after dwell without resetting dwell on a facts refresh', () => {
        const visible = { ...facts, visible: true };
        const rest = createNotchPresentation(visible);
        const entered = reduceNotchPresentation(rest, { type: 'enter' }, visible);
        expect(notchPresentationDelay(entered, visible)).toBe(1000);
        expect(reduceNotchPresentation(entered, { type: 'facts', facts: visible }, visible)).toBe(entered);
        expect(reduceNotchPresentation(entered, { type: 'dwell' }, visible).surface).toBe('expanded');
        const left = reduceNotchPresentation(entered, { type: 'leave' }, visible);
        expect(notchPresentationDelay(left, visible)).toBeNull();
        expect(reduceNotchPresentation(left, { type: 'dwell' }, visible)).toBe(left);
    });

    it('a press in another Happier window unpins, while Escape preserves a draft', () => {
        const pinned = reduceNotchPresentation(createNotchPresentation(facts), { type: 'pin' }, facts);
        expect(pinned.surface).toBe('pinned');
        expect(reduceNotchPresentation(pinned, { type: 'leave' }, facts).pending).toBeNull();
        const draft = { ...facts, draftLocked: true };
        expect(reduceNotchPresentation(pinned, { type: 'escape' }, draft)).toBe(pinned);
        expect(reduceNotchPresentation(pinned, { type: 'outsidePress' }, draft).surface).toBe('camera_tip');
    });

    it('Action state inputs are idempotent and can open a hidden idle notch', () => {
        const hiddenFacts = { ...facts, idle: 'hidden' } as const;
        const hidden = createNotchPresentation(hiddenFacts);
        const pinned = reduceNotchPresentation(hidden, { type: 'set', state: 'pinned' }, hiddenFacts);
        expect(pinned.surface).toBe('pinned');
        expect(reduceNotchPresentation(pinned, { type: 'set', state: 'pinned' }, hiddenFacts)).toBe(pinned);
        expect(reduceNotchPresentation(pinned, { type: 'set', state: 'open' }, hiddenFacts).surface).toBe('expanded');
        expect(reduceNotchPresentation(pinned, { type: 'set', state: 'rest' }, hiddenFacts).surface).toBe('hidden');
    });
    it('camera tip grows after the policy dwell, then returns on the existing leave delay', () => {
        const tip = createNotchPresentation(facts);
        expect(tip.surface).toBe('camera_tip');
        const entered = reduceNotchPresentation(tip, { type: 'enter' }, facts);
        expect(entered.surface).toBe('camera_tip');
        expect(notchPresentationDelay(entered, facts)).toBe(1000);
        const peek = reduceNotchPresentation(entered, { type: 'dwell' }, facts);
        expect(peek.surface).toBe('peek');
        expect(peek.engaged).toBe(true);
        const left = reduceNotchPresentation(peek, { type: 'leave' }, facts);
        expect(left.engaged).toBe(peek.engaged);
        expect(notchPresentationDelay(left, facts)).toBe(1500);
        expect(reduceNotchPresentation(left, { type: 'leaveElapsed' }, facts).surface).toBe('camera_tip');
    });

    it('short crossings create no presentation changes and resting input retains identity', () => {
        const tip = createNotchPresentation(facts);
        let current = tip;
        for (let crossing = 0; crossing < 3; crossing += 1) {
            current = reduceNotchPresentation(current, { type: 'enter' }, facts);
            expect({ surface: current.surface, engaged: current.engaged })
                .toEqual({ surface: tip.surface, engaged: tip.engaged });
            current = reduceNotchPresentation(current, { type: 'leave' }, facts);
            expect(current.surface).toBe(tip.surface);
            expect(notchPresentationDelay(current, facts)).toBeNull();
        }
        expect(reduceNotchPresentation(current, { type: 'leaveElapsed' }, facts)).toBe(current);
        expect(reduceNotchPresentation(current, { type: 'facts', facts }, facts)).toBe(current);
    });

    it('uses the admitted visible fact and all three idle preferences, with disabled always hidden', () => {
        expect(createNotchPresentation({ ...facts, cameraNotch: false }).surface).toBe('tip');
        expect(createNotchPresentation({ ...facts, idle: 'full' }).surface).toBe('collapsed');
        expect(createNotchPresentation({ ...facts, idle: 'hidden' }).surface).toBe('hidden');
        expect(createNotchPresentation({ ...facts, visible: true }).surface).toBe('collapsed');
        expect(createNotchPresentation({ ...facts, enabled: false, visible: true }).surface).toBe('hidden');
        const tip = createNotchPresentation(facts);
        expect(reduceNotchPresentation(tip, { type: 'facts', facts: { ...facts, visible: true } }, facts).surface).toBe('collapsed');
    });

    it('click skips dwell and disabling closes even an engaged surface', () => {
        const entered = reduceNotchPresentation(createNotchPresentation(facts), { type: 'enter' }, facts);
        const open = reduceNotchPresentation(entered, { type: 'click' }, facts);
        expect(open.surface).toBe('expanded');
        expect(notchPresentationDelay(open, facts)).toBeNull();
        expect(reduceNotchPresentation(open, { type: 'facts', facts: { ...facts, enabled: false } }, facts))
            .toMatchObject({ surface: 'hidden', engaged: false, pending: null });
    });

    it('holds requests, drafts and focus; unlocking while outside resumes a single leave delay', () => {
        const open = reduceNotchPresentation(createNotchPresentation(facts), { type: 'click' }, facts);
        for (const lock of ['draftLocked', 'focusWithin', 'blockingCard'] as const) {
            const locked = { ...facts, [lock]: true };
            const left = reduceNotchPresentation(open, { type: 'leave' }, locked);
            expect(notchPresentationDelay(left, locked)).toBeNull();
            expect(reduceNotchPresentation(left, { type: 'leaveElapsed' }, locked).surface).toBe('expanded');
            const unlocked = reduceNotchPresentation(left, { type: 'facts', facts }, locked);
            expect(notchPresentationDelay(unlocked, facts)).toBe(1500);
        }
    });

    it('does not let an obsolete dwell fire after leaving or changing the rest variant', () => {
        const entered = reduceNotchPresentation(createNotchPresentation(facts), { type: 'enter' }, facts);
        const left = reduceNotchPresentation(entered, { type: 'leave' }, facts);
        expect(reduceNotchPresentation(left, { type: 'dwell' }, facts)).toBe(left);
        const hiddenFacts = { ...facts, idle: 'hidden' } as const;
        const hidden = reduceNotchPresentation(entered, { type: 'facts', facts: hiddenFacts }, facts);
        expect(hidden.surface).toBe('hidden');
        expect(reduceNotchPresentation(hidden, { type: 'dwell' }, hiddenFacts)).toBe(hidden);
    });

    it('keeps a parked pointer engaged as content changes and rearms dwell when the tip returns', () => {
        const entered = reduceNotchPresentation(createNotchPresentation(facts), { type: 'enter' }, facts);
        const content = { ...facts, visible: true };
        const collapsed = reduceNotchPresentation(entered, { type: 'facts', facts: content }, facts);
        expect(collapsed).toMatchObject({ surface: 'collapsed', engaged: true, pointerInside: true, pending: 'dwell' });
        const tip = reduceNotchPresentation(collapsed, { type: 'facts', facts }, content);
        expect(tip).toMatchObject({ surface: 'camera_tip', engaged: false, pointerInside: true, pending: 'dwell' });
        expect(notchPresentationDelay(tip, facts)).toBe(1000);
    });
});

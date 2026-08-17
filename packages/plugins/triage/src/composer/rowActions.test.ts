import { describe, expect, it } from 'vitest';

import {
    describeTriageRowActions,
    resolveTriageRowActionLayout,
    type TriageRowActionLayoutInputV1,
} from './rowActions.js';
import type { TriagePickerRowV1 } from './pickerModel.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const SOURCE_INSTANCE = { source: SOURCE, sourceInstanceId: '2f1c9b4e-7a55-4a8c-9d2e-0b6f4c3a1d78' } as const;

/** iOS's public floor; Android's 48 dp is exercised alongside it below. */
const IOS_TARGET = 44;
const ANDROID_TARGET = 48;

function layoutInput(overrides: Partial<TriageRowActionLayoutInputV1> = {}): TriageRowActionLayoutInputV1 {
    return {
        availableWidth: 360,
        actionWidths: [72, 96],
        titleMinimumWidth: 120,
        minimumInteractiveTargetSize: IOS_TARGET,
        gap: 8,
        direction: 'ltr',
        ...overrides,
    };
}

function pickerRow(overrides: Partial<TriagePickerRowV1> = {}): TriagePickerRowV1 {
    return {
        id: 'row-key',
        entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'origin', entryId: '42' },
        title: 'Fix the parser crash',
        scopeLabel: 'acme/web',
        activatesOnPress: false,
        attachment: { kind: 'notAttached' },
        mutation: {
            kind: 'attach',
            sourceInstance: SOURCE_INSTANCE,
            presentation: { label: 'Fix the parser crash', description: 'acme/web' },
        },
        viewDetails: { kind: 'open', sourceInstance: SOURCE_INSTANCE },
        ...overrides,
    };
}

describe('resolveTriageRowActionLayout', () => {
    it('keeps exactly two actions in the same logical order in every arrangement', () => {
        const arrangements = [
            resolveTriageRowActionLayout(layoutInput()),
            resolveTriageRowActionLayout(layoutInput({ availableWidth: 220 })),
            resolveTriageRowActionLayout(layoutInput({ availableWidth: 120, actionWidths: [110, 118] })),
        ];

        expect(arrangements.map((layout) => layout.arrangement)).toEqual(['inline', 'wrapped', 'stacked']);
        for (const layout of arrangements) {
            expect(layout.actions.map((action) => action.actionId)).toEqual(['attachment', 'viewDetails']);
            expect(layout.actions.map((action) => action.order)).toEqual([0, 1]);
        }
    });

    it('gives the title its first claim on inline space', () => {
        const layout = resolveTriageRowActionLayout(layoutInput());

        expect(layout.arrangement).toBe('inline');
        expect(layout.titleWidth).toBeGreaterThanOrEqual(120);
        const consumed = layout.titleWidth + layout.actions.reduce((total, action) => total + action.width, 0);
        expect(consumed + 2 * 8).toBeLessThanOrEqual(360);
    });

    it('wraps both actions under the title rather than starving it', () => {
        // 120 pt of title plus two actions and their gaps does not fit in 220 pt.
        const layout = resolveTriageRowActionLayout(layoutInput({ availableWidth: 220 }));

        expect(layout.arrangement).toBe('wrapped');
        expect(layout.titleWidth).toBe(220);
    });

    it('stacks the two actions when a long localization cannot share one line', () => {
        const layout = resolveTriageRowActionLayout(layoutInput({
            availableWidth: 320,
            actionWidths: [190, 210],
        }));

        expect(layout.arrangement).toBe('stacked');
        expect(layout.actions.map((action) => action.width)).toEqual([320, 320]);
    });

    it('never renders a target below the platform floor, even for a short label', () => {
        for (const minimumInteractiveTargetSize of [IOS_TARGET, ANDROID_TARGET]) {
            const layout = resolveTriageRowActionLayout(layoutInput({
                actionWidths: [12, 16],
                minimumInteractiveTargetSize,
            }));

            for (const action of layout.actions) {
                expect(action.width).toBeGreaterThanOrEqual(minimumInteractiveTargetSize);
                expect(action.height).toBeGreaterThanOrEqual(minimumInteractiveTargetSize);
            }
        }
    });

    it('never lets the two inline actions exceed the space beside the title', () => {
        // Overlap and clipping are the same defect measured differently: the sum
        // of the title, both targets and both gaps must fit the row.
        const layout = resolveTriageRowActionLayout(layoutInput({ availableWidth: 400, actionWidths: [140, 150] }));
        const consumed = layout.arrangement === 'inline'
            ? layout.titleWidth + layout.actions.reduce((total, action) => total + action.width, 0) + 2 * 8
            : layout.actions.reduce((total, action) => total + action.width, 0) + 8;

        expect(consumed).toBeLessThanOrEqual(400);
    });

    it('mirrors physical placement under RTL without reordering the actions', () => {
        const ltr = resolveTriageRowActionLayout(layoutInput());
        const rtl = resolveTriageRowActionLayout(layoutInput({ direction: 'rtl' }));

        expect(ltr.physicalAlignment).toBe('right');
        expect(rtl.physicalAlignment).toBe('left');
        expect(rtl.actions.map((action) => action.actionId)).toEqual(ltr.actions.map((action) => action.actionId));
        expect(rtl.actions.map((action) => action.order)).toEqual([0, 1]);
    });
});

describe('describeTriageRowActions', () => {
    it('describes exactly two independently labelled actions in render and focus order', () => {
        const actions = describeTriageRowActions(pickerRow());

        expect(actions.map((action) => action.actionId)).toEqual(['attachment', 'viewDetails']);
        expect(actions[0]).toEqual({ actionId: 'attachment', intent: 'attach', enabled: true });
        expect(actions[1]).toEqual({ actionId: 'viewDetails', intent: 'open', enabled: true });
    });

    it('names Remove for an attached row', () => {
        const actions = describeTriageRowActions(pickerRow({
            attachment: { kind: 'attached', instanceId: 'triage-1' },
            mutation: { kind: 'remove', instanceId: 'triage-1' },
        }));

        expect(actions[0]).toEqual({ actionId: 'attachment', intent: 'remove', enabled: true });
    });

    it('disables only the action that cannot run', () => {
        // The two actions are independent: an entry no live connection observes
        // cannot be attached or opened, but an attached one can still be removed.
        const unobserved = describeTriageRowActions(pickerRow({
            mutation: { kind: 'unavailable', reason: 'noObservingInstance' },
            viewDetails: { kind: 'unavailable', reason: 'noObservingInstance' },
        }));
        const removableOnly = describeTriageRowActions(pickerRow({
            attachment: { kind: 'attached', instanceId: 'triage-1' },
            mutation: { kind: 'remove', instanceId: 'triage-1' },
            viewDetails: { kind: 'unavailable', reason: 'noObservingInstance' },
        }));

        expect(unobserved.map((action) => action.enabled)).toEqual([false, false]);
        expect(removableOnly.map((action) => action.enabled)).toEqual([true, false]);
    });
});

import { describe, expect, it } from 'vitest';

import { describeTriageRowActions } from './rowActions.js';
import type { TriagePickerRowV1 } from './pickerModel.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const SOURCE_INSTANCE = { source: SOURCE, sourceInstanceId: '2f1c9b4e-7a55-4a8c-9d2e-0b6f4c3a1d78' } as const;

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

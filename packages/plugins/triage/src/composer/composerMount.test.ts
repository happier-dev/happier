import { describe, expect, it } from 'vitest';

import {
    readTriageComposerControlMount,
    readTriageComposerPickerMount,
} from './composerMount.js';

/**
 * The exact Composer a Triage renderer is allowed to touch.
 *
 * The mount input is the ONLY address. `activeComposer()` and a remembered
 * "the composer that was open" are both wrong here: with two live drafts, the
 * focused one is not necessarily the one this picker was opened from, and
 * attaching to the wrong draft is a silent data defect the user only discovers
 * after sending.
 */

const SESSION_COMPOSER = Object.freeze({ kind: 'session', sessionId: 'session-1' });
const NEW_SESSION_COMPOSER = Object.freeze({ kind: 'newSession', instanceId: 'draft-1' });

function attachmentView(instanceId: string) {
    return {
        v: 1,
        instanceId,
        attachment: { pluginId: 'happier.triage', localId: 'entry' },
        key: 'k'.repeat(43),
        value: { v: 1 },
        presentation: { label: 'Replace the normalizer', typeLabel: 'Pull request' },
        availability: { status: 'ready' },
    };
}

function pickerInput(overrides: Readonly<Record<string, unknown>> = {}) {
    return {
        v: 1,
        role: 'attachmentPicker',
        composer: SESSION_COMPOSER,
        attachmentLocalId: 'entry',
        instances: [attachmentView('instance-1')],
        ...overrides,
    };
}

function controlInput(overrides: Readonly<Record<string, unknown>> = {}) {
    return {
        v: 1,
        role: 'controlCompact',
        composer: NEW_SESSION_COMPOSER,
        controlLocalId: 'entries',
        state: { selected: false },
        ...overrides,
    };
}

describe('the Triage composer mount binding', () => {
    it('binds the picker to the exact composer the host stamped, with its current instances', () => {
        const mount = readTriageComposerPickerMount(pickerInput());

        expect(mount).toEqual({
            status: 'bound',
            composer: { kind: 'session', sessionId: 'session-1' },
            instances: [attachmentView('instance-1')],
        });
    });

    it('binds the compact control to the exact newSession composer, and to nothing else', () => {
        const mount = readTriageComposerControlMount(controlInput());

        // Only the address. The host's own `state` — its label, its count, its
        // selected flag — is deliberately NOT carried through: zero/one/many is
        // derived from the canonical attachment snapshot, and exposing a second
        // count here is how a renderer accidentally acquires one.
        expect(mount).toEqual({
            status: 'bound',
            composer: { kind: 'newSession', instanceId: 'draft-1' },
        });
    });

    it('refuses a mount that is not a composer mount at all', () => {
        // An app-page mount carries ordinary launch input. Treating it as a
        // composer mount is how a picker starts writing to a draft it was never
        // opened from.
        expect(readTriageComposerPickerMount(undefined))
            .toEqual({ status: 'unbound', reason: 'absent' });
        expect(readTriageComposerControlMount(undefined))
            .toEqual({ status: 'unbound', reason: 'absent' });
        expect(readTriageComposerPickerMount({ v: 1, kind: 'entryDetail' }))
            .toEqual({ status: 'unbound', reason: 'invalidInput' });
    });

    it('refuses the other role rather than reading its composer anyway', () => {
        // Both roles carry `composer`, so a shape-blind reader happily binds a
        // picker to a control mount and vice versa.
        expect(readTriageComposerPickerMount(controlInput()))
            .toEqual({ status: 'unbound', reason: 'otherRole' });
        expect(readTriageComposerControlMount(pickerInput()))
            .toEqual({ status: 'unbound', reason: 'otherRole' });
        expect(readTriageComposerControlMount(controlInput({ role: 'controlInteraction' })))
            .toEqual({ status: 'unbound', reason: 'otherRole' });
    });

    it('refuses a mount for another contribution of this same plugin', () => {
        // The host validates that the input names an admitted contribution, but
        // not that it names THIS renderer's contribution. A second Triage
        // attachment would otherwise be picked and written by the entry picker.
        expect(readTriageComposerPickerMount(pickerInput({
            attachmentLocalId: 'other',
            instances: [],
        }))).toEqual({ status: 'unbound', reason: 'otherContribution' });
        expect(readTriageComposerControlMount(controlInput({ controlLocalId: 'other' })))
            .toEqual({ status: 'unbound', reason: 'otherContribution' });
    });

    it('refuses input the canonical composer schema rejects', () => {
        // Not a cosmetic check: an unparsed `composer` is exactly what would be
        // handed to `composers.get`, and a malformed ref addresses nothing.
        expect(readTriageComposerPickerMount(pickerInput({ composer: { kind: 'session' } })))
            .toEqual({ status: 'unbound', reason: 'invalidInput' });
        expect(readTriageComposerPickerMount(pickerInput({ extra: true })))
            .toEqual({ status: 'unbound', reason: 'invalidInput' });
    });
});

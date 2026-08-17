import { describe, expect, it } from 'vitest';

import {
    buildTriageEntryDetailLaunchInput,
    parseTriageEntryDetailLaunchInput,
} from './entryDetailLaunchInput.js';

/**
 * The strict private launch input the Triage app page accepts
 * (`core/COMPOSER.md` §2.1).
 *
 * It is the whole boundary between "some surface asked to open a detail" and
 * "Triage selected this exact entry under this exact connection". The generic
 * navigation owner carries the value unchanged and never inspects it, so if
 * this parser is permissive, nothing downstream is strict.
 */

const SOURCE = Object.freeze({ pluginId: 'happier.scm.forge.github', localId: 'github' });
const OTHER_SOURCE = Object.freeze({ pluginId: 'happier.scm.forge.gitlab', localId: 'gitlab' });
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

const ENTRY_REF = Object.freeze({
    source: SOURCE,
    kindId: 'pull-request',
    collisionScope: 'example/repository',
    entryId: '42',
});
const SOURCE_INSTANCE = Object.freeze({ source: SOURCE, sourceInstanceId: INSTANCE_ID });

function launchInput(overrides: Readonly<Record<string, unknown>> = {}) {
    return { v: 1, kind: 'entryDetail', entryRef: ENTRY_REF, sourceInstance: SOURCE_INSTANCE, ...overrides };
}

describe('the Triage entry-detail launch input', () => {
    it('accepts exactly the entry and the connection it was selected under', () => {
        const parsed = parseTriageEntryDetailLaunchInput(launchInput());

        expect(parsed).toEqual({
            status: 'valid',
            input: { v: 1, kind: 'entryDetail', entryRef: ENTRY_REF, sourceInstance: SOURCE_INSTANCE },
        });
    });

    it('round-trips the value the builder produces', () => {
        const built = buildTriageEntryDetailLaunchInput({
            entryRef: ENTRY_REF,
            sourceInstance: SOURCE_INSTANCE,
        });

        expect(parseTriageEntryDetailLaunchInput(built)).toEqual({ status: 'valid', input: built });
    });

    it('refuses an instance of a different source than the entry', () => {
        // A connection to another forge could never have observed this entry.
        // Accepting the pair would open the detail under an account that has to
        // guess what it is looking at.
        expect(parseTriageEntryDetailLaunchInput(launchInput({
            sourceInstance: { source: OTHER_SOURCE, sourceInstanceId: INSTANCE_ID },
        }))).toEqual({ status: 'invalid', reason: 'sourceMismatch' });
    });

    it('refuses anything the closed shape does not name', () => {
        // Deliberately load-bearing: `originComposer` is the field this input
        // will gain once the canonical composable Composer-ref projection
        // exists. Until then it must be REFUSED rather than carried as opaque
        // JSON, because a Triage-local mirror of that ref is exactly what the
        // program forbids.
        expect(parseTriageEntryDetailLaunchInput(launchInput({
            originComposer: { kind: 'session', sessionId: 'session-1' },
        }))).toEqual({ status: 'invalid', reason: 'shape' });

        expect(parseTriageEntryDetailLaunchInput(launchInput({ refreshedAtMs: 1 })))
            .toEqual({ status: 'invalid', reason: 'shape' });
    });

    it('refuses a foreign, mistyped or incomplete payload', () => {
        expect(parseTriageEntryDetailLaunchInput(undefined)).toEqual({ status: 'invalid', reason: 'shape' });
        expect(parseTriageEntryDetailLaunchInput({ url: 'https://example.test/pull/42' }))
            .toEqual({ status: 'invalid', reason: 'shape' });
        expect(parseTriageEntryDetailLaunchInput(launchInput({ kind: 'entry' })))
            .toEqual({ status: 'invalid', reason: 'shape' });
        expect(parseTriageEntryDetailLaunchInput(launchInput({ v: 2 })))
            .toEqual({ status: 'invalid', reason: 'shape' });
        expect(parseTriageEntryDetailLaunchInput({ v: 1, kind: 'entryDetail', entryRef: ENTRY_REF }))
            .toEqual({ status: 'invalid', reason: 'shape' });
        expect(parseTriageEntryDetailLaunchInput(launchInput({
            sourceInstance: { source: SOURCE, sourceInstanceId: 'not-a-uuid' },
        }))).toEqual({ status: 'invalid', reason: 'shape' });
    });
});

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

/** Exactly the five arms the host publishes — this input admits no sixth. */
const COMPOSER_SCOPES = Object.freeze([
    { kind: 'session', sessionId: 'session-1' },
    { kind: 'newSession', instanceId: 'composer-instance-1' },
    { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
    { kind: 'participantMessage', sessionId: 'session-1', instanceId: 'composer-instance-1' },
    { kind: 'automationAuthoring', sessionId: 'session-1', instanceId: 'composer-instance-1' },
] as const);

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
        // `originComposer` is now declared (see below) through the canonical
        // `ProtocolComposerRefV1Schema`, so the field this test still has to
        // hold shut is any OTHER unnamed one: a closed shape that quietly
        // grows a second carrier is how a Triage-local mirror slips in.
        expect(parseTriageEntryDetailLaunchInput(launchInput({ refreshedAtMs: 1 })))
            .toEqual({ status: 'invalid', reason: 'shape' });

        expect(parseTriageEntryDetailLaunchInput(launchInput({ launchOrigin: 'composer' })))
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

/**
 * `originComposer` is the ONE field a Composer-origin launch adds
 * (`core/COMPOSER.md` §2.1, PEP `03d1` §17.8). The Composer-origin launch slice
 * has landed: the field is declared here, on the CLOSED private launch input,
 * through the canonical composable projection `ProtocolComposerRefV1Schema`
 * published by `@happier-dev/plugin-sdk/protocol` — never a Triage copy.
 *
 * It lives here rather than on the `additive-open/drop` detail surface envelope
 * because it is an ADDRESS. The destination resolves it with an exact
 * `get(originComposer)`, so a policy that silently drops what it does not know
 * would hand that destination a launch it cannot trace back to its origin, with
 * no signal at all. Closed refuses loudly instead.
 */
describe('a Composer-origin entry-detail launch', () => {
    it('carries the exact mounted Composer scope, on every host arm', () => {
        for (const originComposer of COMPOSER_SCOPES) {
            expect(parseTriageEntryDetailLaunchInput(launchInput({ originComposer })))
                .toEqual({ status: 'valid', input: { ...launchInput(), originComposer } });
        }
    });

    it('omits the field entirely on an ordinary app-origin launch', () => {
        const built = buildTriageEntryDetailLaunchInput({
            entryRef: ENTRY_REF,
            sourceInstance: SOURCE_INSTANCE,
        });

        expect(Object.hasOwn(built, 'originComposer')).toBe(false);
    });

    it('round-trips the exact ref the builder was given', () => {
        const originComposer = { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' } as const;
        const built = buildTriageEntryDetailLaunchInput({
            entryRef: ENTRY_REF,
            sourceInstance: SOURCE_INSTANCE,
            originComposer,
        });

        expect(built.originComposer).toEqual(originComposer);
        expect(parseTriageEntryDetailLaunchInput(built)).toEqual({ status: 'valid', input: built });
    });

    it('refuses a scope the host never stamps rather than dropping it', () => {
        // Each of these is a plausible near-miss: an arm missing its required
        // member, an invented arm, an arm carrying a member from another one,
        // and an identity the host's own grammar rejects.
        for (const originComposer of [
            { kind: 'session' },
            { kind: 'sessionDraft', sessionId: 'session-1' },
            { kind: 'pendingMessage', sessionId: 'session-1' },
            { kind: 'session', sessionId: 'session-1', localId: 'pending-1' },
            { kind: 'newSession', instanceId: ' leading-whitespace' },
            { kind: 'session', sessionId: 'session-1', unknownArmField: true },
        ]) {
            expect(
                parseTriageEntryDetailLaunchInput(launchInput({ originComposer })),
                JSON.stringify(originComposer),
            ).toEqual({ status: 'invalid', reason: 'shape' });
        }
    });

    it('never lets an origin Composer excuse a mismatched entry and connection', () => {
        // The address says where the reader came FROM. It cannot vouch for what
        // they are being shown.
        expect(parseTriageEntryDetailLaunchInput(launchInput({
            originComposer: { kind: 'session', sessionId: 'session-1' },
            sourceInstance: { source: OTHER_SOURCE, sourceInstanceId: INSTANCE_ID },
        }))).toEqual({ status: 'invalid', reason: 'sourceMismatch' });
    });
});

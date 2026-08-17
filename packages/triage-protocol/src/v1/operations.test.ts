import { describe, expect, it } from 'vitest';

import { createTriageSourceV1Fixture } from '../testing/v1/fixtures.js';
import {
    TriageConfiguredSourceInstanceV1Schema,
    TriageListInstancesInputV1Schema,
    TriageListInstancesResultV1Schema,
    TriageSourceInstanceDraftV1Schema,
} from './instances.js';
import {
    TriageGetInputV1Schema,
    TriageGetResultV1Schema,
    TriageScanInputV1Schema,
    TriageScanResultV1Schema,
} from './operations.js';

const fixture = createTriageSourceV1Fixture();
const instance = fixture.configuredInstance;
const present = fixture.getResult;

describe('Triage scan paging', () => {
    it('carries a limit on the initial arm only', () => {
        expect(TriageScanInputV1Schema.safeParse({
            v: 1,
            instance,
            page: { kind: 'initial', limit: 32 },
        }).success).toBe(true);
        expect(TriageScanInputV1Schema.safeParse({
            v: 1,
            instance,
            page: { kind: 'continuation', continuation: { v: 1, token: 'cursor' } },
        }).success).toBe(true);
        // A mid-scan limit change must be unrepresentable: the continuation
        // already binds the initial limit (CONTRACT.md §5.1).
        expect(TriageScanInputV1Schema.safeParse({
            v: 1,
            instance,
            page: { kind: 'continuation', continuation: { v: 1, token: 'cursor' }, limit: 8 },
        }).success).toBe(false);
    });

    it('clamps a scan page request to the V1 throughput ceiling', () => {
        expect(TriageScanInputV1Schema.safeParse({
            v: 1,
            instance,
            page: { kind: 'initial', limit: 65 },
        }).success).toBe(false);
        expect(TriageScanInputV1Schema.safeParse({
            v: 1,
            instance,
            page: { kind: 'initial', limit: 0 },
        }).success).toBe(false);
    });
});

describe('Triage scan result', () => {
    it('cannot express a retry deadline on a successful page', () => {
        expect(TriageScanResultV1Schema.safeParse({
            kind: 'complete',
            observations: [present],
            evidence: { kind: 'walkFinished' },
            retryNotBeforeMs: 1_760_000_000_000,
        }).success).toBe(false);
        expect(TriageScanResultV1Schema.safeParse({
            kind: 'failed',
            failure: {
                class: 'rateLimit',
                code: 'example-rate-limited',
                retryNotBeforeMs: 1_760_000_000_000,
            },
        }).success).toBe(true);
    });

    it('requires a continuation on the continuing arm and forbids one on complete', () => {
        expect(TriageScanResultV1Schema.safeParse({
            kind: 'page',
            observations: [present],
            evidence: { kind: 'moving', reason: 'example-window-moved' },
        }).success).toBe(false);
        expect(TriageScanResultV1Schema.safeParse({
            kind: 'complete',
            observations: [present],
            evidence: { kind: 'walkFinished' },
            continuation: { v: 1, token: 'cursor' },
        }).success).toBe(false);
    });

    it('rejects an absent observation in any scan arm', () => {
        expect(TriageScanResultV1Schema.safeParse({
            kind: 'complete',
            observations: [{ kind: 'absent', localRef: present.localRef }],
            evidence: { kind: 'walkFinished' },
        }).success).toBe(false);
    });
});

describe('Triage get input', () => {
    const localRef = present.localRef;

    it('carries the last-known source locator so an account-wide entry stays routable', () => {
        const parsed = TriageGetInputV1Schema.safeParse({
            v: 1,
            instance,
            localRef,
            lastKnownLocator: {
                v: 1,
                webUrl: 'https://example.test/example/repository/pull/17',
                routingToken: 'example-route-token-v1',
            },
        });
        expect(parsed.success).toBe(true);
        // The token stays exactly the source's own bytes: the target copies the
        // newest observed locator back and never parses or rewrites it.
        expect(parsed.success && parsed.data.lastKnownLocator?.routingToken)
            .toBe('example-route-token-v1');
    });

    it('stays valid without a locator, because a first read may have none', () => {
        expect(TriageGetInputV1Schema.safeParse({ v: 1, instance, localRef }).success).toBe(true);
    });

    it('admits no second routing carrier beside the locator', () => {
        for (const smuggled of [
            { routingToken: 'example-route-token-v1' },
            { locator: { v: 1, routingToken: 'example-route-token-v1' } },
            { lastKnownLocator: { v: 1, repository: 'example/repository' } },
        ]) {
            expect(TriageGetInputV1Schema.safeParse({ v: 1, instance, localRef, ...smuggled })
                .success).toBe(false);
        }
    });
});

describe('Triage get result', () => {
    it('is exactly the complete four-arm observation union', () => {
        expect(TriageGetResultV1Schema.safeParse(present).success).toBe(true);
        expect(TriageGetResultV1Schema.safeParse({
            kind: 'absent',
            localRef: present.localRef,
        }).success).toBe(true);
        expect(TriageGetResultV1Schema.safeParse({
            kind: 'notFound',
            localRef: present.localRef,
        }).success).toBe(false);
    });
});

describe('Triage listInstances', () => {
    it('accepts no binding, account list, cursor, or credential input', () => {
        expect(TriageListInstancesInputV1Schema.safeParse({ v: 1 }).success).toBe(true);
        for (const smuggled of [
            { binding: instance.binding },
            { accounts: [instance.binding.account] },
            { cursor: 'page-2' },
            { limit: 10 },
        ]) {
            expect(TriageListInstancesInputV1Schema.safeParse({ v: 1, ...smuggled }).success)
                .toBe(false);
        }
    });

    it('keeps a truncated enumeration and a bounded cap representable without claiming complete', () => {
        const failure = { class: 'unsupportedContract', code: 'example-instance-cap-reached' };
        expect(TriageListInstancesResultV1Schema.safeParse({
            kind: 'incomplete',
            candidates: [],
            failures: [],
            failure,
        }).success).toBe(true);
        // `complete` is the only complete enumeration, so it carries no
        // top-level failure that could hide an unrepresented account.
        expect(TriageListInstancesResultV1Schema.safeParse({
            kind: 'complete',
            candidates: [],
            failures: [],
            failure,
        }).success).toBe(false);
    });

    it('scopes an exact-binding failure by binding and optional local key', () => {
        const binding = instance.binding;
        const failure = { class: 'permission', code: 'example-forbidden' };
        expect(TriageListInstancesResultV1Schema.safeParse({
            kind: 'complete',
            candidates: [],
            failures: [{ binding, failure }],
        }).success).toBe(true);
        expect(TriageListInstancesResultV1Schema.safeParse({
            kind: 'complete',
            candidates: [],
            failures: [{ binding, localInstanceKey: 'example:41231', failure }],
        }).success).toBe(true);
        expect(TriageListInstancesResultV1Schema.safeParse({
            kind: 'complete',
            candidates: [],
            failures: [{ failure }],
        }).success).toBe(false);
    });
});

describe('Triage composite source-instance keys', () => {
    /**
     * `localInstanceKey` is the second V1 string a first-party source composes
     * from two components: `sources/SENTRY.md` §2.4 pins it to
     * `<normalized deploymentOrigin> U+001F <organizationId>`, the same
     * composite-identifier grammar `CONTRACT.md` §6 gives `collisionScope`. It
     * is a source-owned structural key that no surface renders, so it carries
     * the separator rather than forcing every Sentry configured instance — and
     * therefore every Sentry source operation — to be rejected atomically.
     */
    const UNIT_SEPARATOR = String.fromCodePoint(0x1f);
    const sentryLocalInstanceKey = `https://us.sentry.io${UNIT_SEPARATOR}4503599627370496`;

    const draft = {
        v: 1,
        binding: instance.binding,
        localInstanceKey: sentryLocalInstanceKey,
        keyStability: 'locatorDerived',
        configuration: instance.configuration,
        locator: { v: 1, displayLabel: 'Example organization' },
    };

    it('admits a composed key on a draft, a configured instance, and an exact-binding failure', () => {
        const parsedDraft = TriageSourceInstanceDraftV1Schema.safeParse(draft);
        expect(parsedDraft.success).toBe(true);
        expect(parsedDraft.success && parsedDraft.data.localInstanceKey)
            .toBe(sentryLocalInstanceKey);

        const parsedInstance = TriageConfiguredSourceInstanceV1Schema.safeParse({
            ...instance,
            localInstanceKey: sentryLocalInstanceKey,
        });
        expect(parsedInstance.success).toBe(true);
        expect(parsedInstance.success && parsedInstance.data.localInstanceKey)
            .toBe(sentryLocalInstanceKey);

        expect(TriageListInstancesResultV1Schema.safeParse({
            kind: 'complete',
            candidates: [draft],
            failures: [{
                binding: instance.binding,
                localInstanceKey: sentryLocalInstanceKey,
                failure: { class: 'permission', code: 'example-forbidden' },
            }],
        }).success).toBe(true);
    });

    it('still rejects a malformed key, so relaxing the grammar does not defeat the guard', () => {
        for (const malformed of [
            // A newline is display-breaking content, never a composite key.
            'https://us.sentry.io\n4503599627370496',
            // Any other control character stays unrepresentable, including the
            // record separator one code point below the admitted one.
            `https://us.sentry.io${String.fromCodePoint(0x1e)}4503599627370496`,
            `https://us.sentry.io${String.fromCodePoint(0x00)}4503599627370496`,
            `https://us.sentry.io${String.fromCodePoint(0x7f)}4503599627370496`,
            // The grammar admits one separator between two components, never a
            // second one, and never a bare prefix, suffix, or whole key.
            `https://us.sentry.io${UNIT_SEPARATOR}450${UNIT_SEPARATOR}17`,
            UNIT_SEPARATOR,
            `${UNIT_SEPARATOR}4503599627370496`,
            `https://us.sentry.io${UNIT_SEPARATOR}`,
        ]) {
            expect(
                TriageSourceInstanceDraftV1Schema.safeParse({
                    ...draft,
                    localInstanceKey: malformed,
                }).success,
                malformed,
            ).toBe(false);
            expect(
                TriageConfiguredSourceInstanceV1Schema.safeParse({
                    ...instance,
                    localInstanceKey: malformed,
                }).success,
                malformed,
            ).toBe(false);
        }
    });
});

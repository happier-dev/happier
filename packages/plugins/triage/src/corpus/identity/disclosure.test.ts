import { describe, expect, it } from 'vitest';

import {
    CORPUS_ACCOUNT_COLLECTIONS,
    CORPUS_SESSION_LINKS_COLLECTION,
    CORPUS_SOURCE_INSTANCES_COLLECTION,
    CORPUS_USER_MARKS_COLLECTION,
} from '../collections/definitions.js';
import { CORPUS_IDENTITY_TAG_PATTERN, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../collections/ids.js';
import type {
    CorpusSessionLinkRowV1,
    CorpusSourceInstanceRowV1,
    CorpusUserMarkRowV1,
} from '../collections/rows.js';
import { setPinned } from '../marks/setPinned.js';
import { createTestkitCorpusCollections } from '../testkit/corpusCollections.test-support.js';
import { TRIAGE_TESTKIT_SOURCE, testkitEntryRef } from '../testkit/observations.test-support.js';
import {
    deriveConfiguredSourceInstanceTag,
    deriveSessionLinkEntryTag,
    deriveSessionLinkTag,
    deriveUserMarkTag,
} from './tags.js';

const SECRET_SCOPE = 'octo/private-migration';
const SECRET_ITEM_NUMBER = '4242';
const SECRETS = [SECRET_SCOPE, SECRET_ITEM_NUMBER, 'private-migration'];

/**
 * A durable identity is opaque by construction: fixed width, over the row-id
 * alphabet, and nothing else.
 *
 * This is asserted **beside** the substring sweep because the sweep alone is
 * position-sensitive, and that is not hypothetical — it has already let a real
 * mutant through. A local unkeyed derivation that joined the identity
 * components and truncated them to the tag width
 * (`components.join('').slice(0, 43)`) put the reader's raw provider path
 * straight into the row id, yet spelled only the plugin id and the entry kind
 * inside the first 43 characters; every secret fell off the end, so
 * `not.toContain` passed and only `entryReference.test.ts` caught it. A test
 * whose name promises non-disclosure and whose verdict depends on where the
 * secret happens to land is worse than no test, so it now asserts the property
 * that holds regardless of position: a natural key is not a tag, whatever it
 * happens to spell in its first 43 characters.
 */
const IDENTITY_TAG_SHAPE = new RegExp(CORPUS_IDENTITY_TAG_PATTERN, 'u');

describe('E2EE durable disclosure', () => {
    it('never exposes a raw provider path or item number in an E2EE server record', async () => {
        const fixture = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const entryRef = testkitEntryRef({
            collisionScope: SECRET_SCOPE,
            entryId: SECRET_ITEM_NUMBER,
        });
        await setPinned({
            collections: fixture.collections,
            entryRef,
            pinned: true,
            displayAtMark: { title: `Fix ${SECRET_SCOPE}`, scopeLabel: SECRET_SCOPE },
            nowMs: 1_760_000_900_000,
        });
        const markTag = await deriveUserMarkTag(fixture.collections.userMarks, entryRef);
        const mark = (await fixture.collections.userMarks.get(markTag))?.value as unknown as CorpusUserMarkRowV1;
        const link: CorpusSessionLinkRowV1 = {
            linkTag: await deriveSessionLinkTag(fixture.collections.sessionLinks, entryRef, 'session-a'),
            entryTag: await deriveSessionLinkEntryTag(fixture.collections.sessionLinks, entryRef),
            sessionId: 'session-a',
            linkedAtMs: 1_760_000_900_000,
            cardPublicationId: 'publication-id-a',
            entryRef,
            identityEntryRef: entryRef,
            displayPathAtLink: `${SECRET_SCOPE} #${SECRET_ITEM_NUMBER}`,
        };
        // The configured instance is addressed by the reader's own provider
        // path, so its row id is derived from a secret too — and it was outside
        // this sweep entirely, which is the same defect in its other form.
        const binding = {
            purpose: 'triage-source',
            account: {
                service: { pluginId: TRIAGE_TESTKIT_SOURCE.pluginId, localId: 'accounts' },
                accountId: 'account-1',
            },
        } as const;
        const instance: CorpusSourceInstanceRowV1 = {
            instanceTag: await deriveConfiguredSourceInstanceTag(fixture.collections.sourceInstances, {
                source: TRIAGE_TESTKIT_SOURCE,
                binding,
                localInstanceKey: SECRET_SCOPE,
            }),
            sourceQualifiedId: `${TRIAGE_TESTKIT_SOURCE.pluginId}/${TRIAGE_TESTKIT_SOURCE.localId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
            configuredAtMs: 1_760_000_900_000,
            configured: {
                v: 1,
                instance: { source: TRIAGE_TESTKIT_SOURCE, sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
                binding,
                localInstanceKey: SECRET_SCOPE,
                configuration: { v: 1, token: SECRET_SCOPE },
                locator: { v: 1, displayLabel: SECRET_SCOPE },
            },
        };

        /**
         * Every declared Collection is swept, keyed by its own id rather than by
         * a hand-kept list: a fourth Collection that nobody added a row for
         * fails here instead of quietly leaving this falsifier behind.
         */
        const rowsByCollectionId = new Map<string, Readonly<Record<string, unknown>>>([
            [CORPUS_SOURCE_INSTANCES_COLLECTION.id, instance],
            [CORPUS_SESSION_LINKS_COLLECTION.id, link],
            [CORPUS_USER_MARKS_COLLECTION.id, mark],
        ]);

        for (const definition of CORPUS_ACCOUNT_COLLECTIONS) {
            const row = rowsByCollectionId.get(definition.id);
            expect(row, `no row seeded for the declared collection ${definition.id}`).toBeDefined();
            if (row === undefined) continue;

            const identityFields = definition.identityFields ?? [];
            for (const field of identityFields) {
                expect(row[field]).toEqual(expect.stringMatching(IDENTITY_TAG_SHAPE));
            }

            // The row ids, the whole server-readable projection, and every
            // declared index value. Checking only the row id passes while the
            // projection leaks, so all three are read from the declarations.
            const disclosed = [
                ...identityFields,
                ...definition.serverReadable,
                ...definition.indexes.flatMap((index) => index.fields.map((field) => field.field)),
            ].map((field) => String(row[field]));

            for (const value of disclosed) {
                for (const secret of SECRETS) expect(value).not.toContain(secret);
            }
        }
    });

    it('keeps every entry-identifying and display field out of the projection', () => {
        const contentBearing = new Set([
            'entryRef', 'identityEntryRef', 'displayAtMark', 'displayPathAtLink',
            'cardPublicationId', 'configured',
        ]);
        for (const definition of CORPUS_ACCOUNT_COLLECTIONS) {
            for (const field of definition.serverReadable) {
                expect(contentBearing.has(field)).toBe(false);
            }
            for (const index of definition.indexes) {
                for (const field of index.fields) {
                    expect(contentBearing.has(field.field)).toBe(false);
                }
            }
        }
    });
});

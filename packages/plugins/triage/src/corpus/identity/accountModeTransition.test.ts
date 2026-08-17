import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import {
    CORPUS_SESSION_LINKS_COLLECTION,
    CORPUS_SOURCE_INSTANCES_COLLECTION,
    CORPUS_USER_MARKS_COLLECTION,
} from '../collections/definitions.js';
import type { CorpusIdentityTagHandleV1 } from '../collections/handles.js';
import { TRIAGE_TESTKIT_SOURCE, testkitEntryRef } from '../testkit/observations.test-support.js';
import {
    deriveConfiguredSourceInstanceTag,
    deriveSessionLinkEntryTag,
    deriveSessionLinkTag,
    deriveUserMarkTag,
} from './tags.js';

/**
 * Triage's consumer half of the Account-mode transition contract.
 *
 * A mode change re-derives every identity tag, so the Account transition owner
 * refuses to move a live row of a Collection that declares `identityFields`
 * rather than leave it at an address no client can derive again. That refusal
 * only protects the fields the contract actually declares, which makes the
 * declaration — not the derivation site — the thing this file pins.
 */

const BINDING = {
    purpose: 'example.api',
    account: {
        service: { pluginId: 'happier.example.source', localId: 'example-account' },
        accountId: 'account-1',
    },
} as const;

/** Records which field each derivation asks its collection for. */
function recordingHandle(): Readonly<{
    handle: CorpusIdentityTagHandleV1;
    fields: () => readonly string[];
}> {
    const requested: string[] = [];
    return {
        handle: {
            async identityTag(request) {
                requested.push(request.field);
                return 'recorded-tag';
            },
        },
        fields: () => [...requested],
    };
}

function refusingHandle(): CorpusIdentityTagHandleV1 {
    return {
        async identityTag() {
            throw new PluginError({
                code: 'plugin_collection_invalid_value',
                message: 'Collection identity tag names a field the admitted contract does not declare',
            });
        },
    };
}

describe('Account-mode transition participation', () => {
    it('derives every durable identity through a field its collection declares as mode-derived', async () => {
        // The falsifier for a stranded row: a derivation whose field is absent
        // from `identityFields` produces a mode-bound value the Account
        // transition owner cannot see, so the row is rekeyed past and left at
        // an address its plugin can no longer derive.
        const sourceInstances = recordingHandle();
        await deriveConfiguredSourceInstanceTag(sourceInstances.handle, {
            source: TRIAGE_TESTKIT_SOURCE,
            binding: BINDING,
            localInstanceKey: 'example/repository',
        });

        const sessionLinks = recordingHandle();
        await deriveSessionLinkTag(sessionLinks.handle, testkitEntryRef(), 'session-1');
        await deriveSessionLinkEntryTag(sessionLinks.handle, testkitEntryRef());

        const userMarks = recordingHandle();
        await deriveUserMarkTag(userMarks.handle, testkitEntryRef());

        expect(new Set(sourceInstances.fields()))
            .toEqual(new Set(CORPUS_SOURCE_INSTANCES_COLLECTION.identityFields));
        expect(new Set(sessionLinks.fields()))
            .toEqual(new Set(CORPUS_SESSION_LINKS_COLLECTION.identityFields));
        expect(new Set(userMarks.fields()))
            .toEqual(new Set(CORPUS_USER_MARKS_COLLECTION.identityFields));
    });

    it('surfaces a refused identity derivation instead of falling back to a local tag', async () => {
        // No plugin code holds Account key material, so there is no admissible
        // local spelling of a tag. A fallback would mint an address the host
        // never agreed to and would survive as an unreachable row.
        const refusing = refusingHandle();

        await expect(deriveConfiguredSourceInstanceTag(refusing, {
            source: TRIAGE_TESTKIT_SOURCE,
            binding: BINDING,
            localInstanceKey: 'example/repository',
        })).rejects.toMatchObject({ code: 'plugin_collection_invalid_value' });
        await expect(deriveSessionLinkTag(refusing, testkitEntryRef(), 'session-1'))
            .rejects.toMatchObject({ code: 'plugin_collection_invalid_value' });
        await expect(deriveSessionLinkEntryTag(refusing, testkitEntryRef()))
            .rejects.toMatchObject({ code: 'plugin_collection_invalid_value' });
        await expect(deriveUserMarkTag(refusing, testkitEntryRef()))
            .rejects.toMatchObject({ code: 'plugin_collection_invalid_value' });
    });
});

import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import type {
    TriageEntryRefV1,
    TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';

import type { CorpusIdentityTagHandleV1 } from '../collections/handles.js';
import {
    CORPUS_SESSION_LINKS_FIELD,
    CORPUS_SOURCE_INSTANCES_FIELD,
    CORPUS_USER_MARKS_FIELD,
} from '../collections/ids.js';
import {
    configuredSourceInstanceTagComponents,
    sessionLinkEntryTagComponents,
    sessionLinkTagComponents,
    userMarkTagComponents,
} from './components.js';

/**
 * Every durable identity, derived through the collection it belongs to.
 *
 * A tag is a disclosure decision, not a performance decision: a row id and an
 * indexed value are plaintext server metadata even on an E2EE Account, so a
 * natural provider key never becomes one. Each derivation names its own
 * collection handle and its own declared field, which is what makes two
 * purposes structurally unable to share an identity — and it is why a tag is
 * never copied from one collection to another, even when the components match.
 *
 * The derivation itself is host-owned: no plugin code holds Account key
 * material, and there is no parameter through which one could name another
 * plugin's, collection's or field's derivation domain.
 */

/**
 * The deterministic row address of one exact configured tuple. It is derived
 * from the private match tuple, never from the stable configured-instance id:
 * the tuple addresses the row a create must compare-and-swap against, and the
 * stable id is what that row mints once a writer wins.
 */
export async function deriveConfiguredSourceInstanceTag(
    sourceInstances: CorpusIdentityTagHandleV1,
    input: Readonly<{
        source: PluginContributionIdentity;
        binding: TriageSourceInstanceDraftV1['binding'];
        localInstanceKey: string;
    }>,
    options?: PluginCancellationOptions,
): Promise<string> {
    return await sourceInstances.identityTag({
        field: CORPUS_SOURCE_INSTANCES_FIELD.instanceTag,
        components: configuredSourceInstanceTagComponents(input),
    }, options);
}

export async function deriveSessionLinkTag(
    sessionLinks: CorpusIdentityTagHandleV1,
    identityEntryRef: TriageEntryRefV1,
    sessionId: string,
    options?: PluginCancellationOptions,
): Promise<string> {
    return await sessionLinks.identityTag({
        field: CORPUS_SESSION_LINKS_FIELD.linkTag,
        components: sessionLinkTagComponents(identityEntryRef, sessionId),
    }, options);
}

export async function deriveSessionLinkEntryTag(
    sessionLinks: CorpusIdentityTagHandleV1,
    entryRef: TriageEntryRefV1,
    options?: PluginCancellationOptions,
): Promise<string> {
    return await sessionLinks.identityTag({
        field: CORPUS_SESSION_LINKS_FIELD.entryTag,
        components: sessionLinkEntryTagComponents(entryRef),
    }, options);
}

export async function deriveUserMarkTag(
    userMarks: CorpusIdentityTagHandleV1,
    entryRef: TriageEntryRefV1,
    options?: PluginCancellationOptions,
): Promise<string> {
    return await userMarks.identityTag({
        field: CORPUS_USER_MARKS_FIELD.markTag,
        components: userMarkTagComponents(entryRef),
    }, options);
}

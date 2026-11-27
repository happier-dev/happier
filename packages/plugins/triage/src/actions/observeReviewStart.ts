import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { TriageAdmittedReviewV1Schema } from '@happier-dev/triage-protocol/v1';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { setAdmittedReview } from '../corpus/marks/setPinned.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { REVIEW_START_ACTION_ID } from './actionIdsReview.js';
import { createTriageReobserveEntryActionHandler } from './reobserveEntry.js';
import { createTriageResolveResourceActionHandler } from './resolveResource.js';

const ReviewReceipt = defineProtocolObject({
    reviewTarget: defineProtocolObject({
        url: defineProtocolString({ minLength: 1 }),
        headOid: defineProtocolString({ minLength: 1 }),
    }, { policy: 'additive-open/drop' }),
    reviewRound: TriageAdmittedReviewV1Schema,
}, { policy: 'additive-open/drop' });

const resolveResource = createTriageResolveResourceActionHandler();
const readCurrentEntry = createTriageReobserveEntryActionHandler();

function isJsonRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function observeReviewStart(payload: JsonValue, context: PluginInvocationContext): Promise<void> {
    if (!isJsonRecord(payload) || payload.actionId !== REVIEW_START_ACTION_ID) return;
    if (!isJsonRecord(payload.outcome) || payload.outcome.status !== 'succeeded') return;
    const receipt = ReviewReceipt.safeParse(payload.outcome.result);
    if (!receipt.success) return;

    const { reviewTarget, reviewRound } = receipt.data;
    const { ui: _presentation, ...accountContext } = context;
    const resolved = await resolveResource({ v: 1, resource: { kind: 'pullRequest', url: reviewTarget.url } }, accountContext);
    if (resolved.kind !== 'resolved') return;

    const entry = await readCurrentEntry({
        v: 1,
        entryRef: resolved.entryRef,
        sourceInstanceId: resolved.sourceInstance.sourceInstanceId,
        lastKnownLocator: resolved.locator,
    }, accountContext);
    if (entry.kind !== 'observed' || entry.observation.outcome.kind !== 'present') return;
    const { snapshot } = entry.observation.outcome;
    if (snapshot.reviewRevision?.headSha !== reviewTarget.headOid) return;

    await setAdmittedReview({
        collections: bindCorpusCollections(requireTriageAccountStorage(context)),
        entryRef: entry.entryRef,
        displayAtMark: { title: snapshot.title, scopeLabel: snapshot.scopeLabel },
        admittedReview: reviewRound,
        nowMs: context.invokedAtMs,
        signal: context.signal,
    });
}

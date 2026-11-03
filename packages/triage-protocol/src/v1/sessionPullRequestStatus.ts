import {
    defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { ActionSessionAddressV1Schema, SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';
import { SessionPullRequestBindingMetadataFieldsV1 } from '@happier-dev/channels-protocol/v1';

import { TriageSourceFailureV1Schema } from './diagnostics.js';
import { TriageEntryRefV1Schema, TriageSourceInstanceIdV1Schema } from './identity.js';
import { TriagePullRequestStatusCheckTimeV1Schema, TriagePullRequestStatusV1Schema } from './pullRequestStatus.js';
import { TriageConfigureSourceOfferV1Schema } from './sourceAdministration.js';

const closed = { policy: 'closed' } as const;

/** The host owns the exact Home and Session; Resource input never resolves selectors. */
export const SessionPullRequestStatusResourceInputV1Schema = ActionSessionAddressV1Schema;
export type SessionPullRequestStatusResourceInputV1 = ReturnType<typeof SessionPullRequestStatusResourceInputV1Schema.parse>;

export const SessionPullRequestNativeStatusV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('current'), value: TriagePullRequestStatusV1Schema,
        checkedAtMs: TriagePullRequestStatusCheckTimeV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('stale'), value: TriagePullRequestStatusV1Schema,
        checkedAtMs: TriagePullRequestStatusCheckTimeV1Schema, failure: TriageSourceFailureV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), failure: TriageSourceFailureV1Schema,
        recovery: defineProtocolObject({ kind: defineProtocolLiteral('configureSources'),
            offers: defineProtocolArray(TriageConfigureSourceOfferV1Schema, { minItems: 1 }) }, closed).optional() }, closed),
]);
export type SessionPullRequestNativeStatusV1 = ReturnType<typeof SessionPullRequestNativeStatusV1Schema.parse>;

/** Compose Channels' owned metadata fields without copying its policy or update grammar. */
export const SessionPullRequestStatusResourceResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('ready'), sessionId: SessionIdSchema,
        pullRequests: defineProtocolArray(defineProtocolObject({ ...SessionPullRequestBindingMetadataFieldsV1,
            entry: defineProtocolObject({ entryRef: TriageEntryRefV1Schema,
                sourceInstanceId: TriageSourceInstanceIdV1Schema }, closed).optional(),
            nativeStatus: SessionPullRequestNativeStatusV1Schema }, closed)) }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), sessionId: SessionIdSchema,
        failure: TriageSourceFailureV1Schema }, closed),
]);
export type SessionPullRequestStatusResourceResultV1 = ReturnType<typeof SessionPullRequestStatusResourceResultV1Schema.parse>;

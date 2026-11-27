import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    defineProtocolUniqueArray,
    TriageIdentifierV1ProtocolSchema,
} from '@happier-dev/plugin-sdk/protocol';

import { TRIAGE_SINGLE_LINE_STRING_PATTERN_V1, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from './bounds.js';
import { TriageEntryRefV1Schema, TriageTextV1ProtocolSchema, TriageEntryLocatorV1Schema,
    TriageSourceEntryLocalRefV1Schema, TriageSourceInstanceIdV1Schema } from './identity.js';
import { TriageReadUnavailableV1Schema, TriageSourceFailureV1Schema } from './diagnostics.js';
import { TriageConfiguredSourceInstanceV1Schema } from './instances.js';

export const TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1 = 'marks/read-fix-pull-requests-v1';
export const TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_ID_V1 = 'happier.triage/marks/read-fix-pull-requests-v1';
export const TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_REF_V1 = Object.freeze({
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    localId: TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1,
});
export const TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1 = 'marks/set-fix-pull-request-v1';
export const TRIAGE_SET_FIX_PULL_REQUEST_ACTION_ID_V1 = 'happier.triage/marks/set-fix-pull-request-v1';
export const TRIAGE_SET_FIX_PULL_REQUEST_ACTION_REF_V1 = Object.freeze({
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    localId: TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1,
});

const durableDisplayText = defineProtocolString({ minLength: 1, pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1 });
const display = defineProtocolObject({
    title: durableDisplayText,
    scopeLabel: durableDisplayText,
}, { policy: 'closed' });

const sourceContext = defineProtocolObject({
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
    sourceInstanceRowId: TriageIdentifierV1ProtocolSchema.optional(),
    lastKnownLocator: TriageEntryLocatorV1Schema,
}, { policy: 'closed' });

const status = defineProtocolUnion([
    defineProtocolLiteral('open'), defineProtocolLiteral('merged'),
    defineProtocolLiteral('closed'), defineProtocolLiteral('unknown'),
]);
const sourceCandidateDisplay = defineProtocolObject({
    title: TriageTextV1ProtocolSchema.optional(),
    scopeLabel: TriageTextV1ProtocolSchema.optional(),
    displayPath: TriageTextV1ProtocolSchema.optional(),
}, { policy: 'closed' });

// Resolved candidates may carry retained user choices rather than source projections.
const candidateDisplay = defineProtocolObject({
    title: durableDisplayText.optional(),
    scopeLabel: durableDisplayText.optional(),
    displayPath: durableDisplayText.optional(),
}, { policy: 'closed' });

/** Source-native associations are transient evidence, never user choices. */
export const TriageSourceReadFixPullRequestsResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('complete'),
        candidates: defineProtocolArray(defineProtocolObject({
            localRef: TriageSourceEntryLocalRefV1Schema,
            status,
            display: sourceCandidateDisplay,
            locator: TriageEntryLocatorV1Schema,
        }, { policy: 'closed' })),
    }, { policy: 'closed' }),
    TriageReadUnavailableV1Schema,
]);
export type TriageSourceReadFixPullRequestsResultV1 = ReturnType<typeof TriageSourceReadFixPullRequestsResultV1Schema.parse>;

/** V1 caller envelopes and every nested identity/display object are closed. */
export const TriageReadFixPullRequestsInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    entryRef: TriageEntryRefV1Schema,
    sourceContext: defineProtocolObject({
        instance: TriageConfiguredSourceInstanceV1Schema,
        lastKnownLocator: TriageEntryLocatorV1Schema,
    }, { policy: 'closed' }).optional(),
}, { policy: 'closed' });
export type TriageReadFixPullRequestsInputV1 = ReturnType<typeof TriageReadFixPullRequestsInputV1Schema.parse>;

export const TriageFixPullRequestV1Schema = defineProtocolObject({
    entryRef: TriageEntryRefV1Schema,
    origins: defineProtocolUniqueArray(defineProtocolUnion([
        defineProtocolLiteral('user'),
        defineProtocolLiteral('session'),
        defineProtocolLiteral('native'),
    ]), { minItems: 1, maxItems: 3 }),
    status,
    display: candidateDisplay,
    sourceContext: sourceContext.optional(),
}, { policy: 'closed' });
export type TriageFixPullRequestV1 = ReturnType<typeof TriageFixPullRequestV1Schema.parse>;
export type TriageFixPullRequestStatusV1 = TriageFixPullRequestV1['status'];

/** Owner-resolved read; raw marks and Session siblings stay private to Triage. */
export const TriageReadFixPullRequestsResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    // Explicit choices are durable intent, not bounded relationship query pages.
    candidates: defineProtocolArray(TriageFixPullRequestV1Schema),
    primary: TriageFixPullRequestV1Schema.nullable(),
    incomplete: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
    nativeFailure: TriageSourceFailureV1Schema.optional(),
}, { policy: 'closed' });
export type TriageReadFixPullRequestsResultV1 = ReturnType<typeof TriageReadFixPullRequestsResultV1Schema.parse>;

/** Link/unlink intent invokes the sole private user-marks writer. */
export const TriageSetFixPullRequestInputV1Schema = defineProtocolUnion([
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        linked: defineProtocolLiteral(true),
        entryRef: TriageEntryRefV1Schema,
        displayAtMark: display,
        fixPullRequest: TriageEntryRefV1Schema,
        displayAtLink: display,
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        linked: defineProtocolLiteral(false),
        entryRef: TriageEntryRefV1Schema,
        displayAtMark: display,
        fixPullRequest: TriageEntryRefV1Schema,
    }, { policy: 'closed' }),
]);
export type TriageSetFixPullRequestInputV1 = ReturnType<typeof TriageSetFixPullRequestInputV1Schema.parse>;

export const TriageSetFixPullRequestResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    status: defineProtocolUnion([
        defineProtocolLiteral('linked'),
        defineProtocolLiteral('unlinked'),
        defineProtocolLiteral('conflict'),
    ]),
}, { policy: 'closed' });
export type TriageSetFixPullRequestResultV1 = ReturnType<typeof TriageSetFixPullRequestResultV1Schema.parse>;

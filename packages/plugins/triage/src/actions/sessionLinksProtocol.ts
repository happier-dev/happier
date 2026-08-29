import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    TriageEntryLocatorV1Schema,
    TriageEntryRefV1Schema,
} from '@happier-dev/triage-protocol/v1';

/**
 * The strict contract of the one `session-links` writer Action.
 *
 * A mounted surface reaches no Account Collection of its own — the Host API it
 * holds exposes Actions, not storage — so this is the only transport between
 * the affordance that starts work on an entry and the canonical link writer.
 * Like the user-mark Actions it is declared here rather than in
 * `@happier-dev/triage-protocol`: publishing a link-writing shape cross-plugin
 * would invite a second authority over the relationship the corpus contract
 * gives exactly one owner.
 *
 * The minted link tag is deliberately absent from the result. A row id is
 * plaintext server metadata even on an E2EE Account, and nothing a surface
 * renders needs one: the Session cockpit reads its links through the declared
 * UI query, addressed by the mounted `SessionId` alone.
 */

const triageText = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

/** The host-stamped mounted `SessionId`, bounded by the durable row's own field. */
const triageSessionId = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

/**
 * The entry as the caller's device-local projection rendered it.
 *
 * The locator travels whole rather than pre-resolved to a path: which of its
 * members a link freezes — and what stands in when a source emitted none — is
 * the writer's decision, and a caller that resolved it first would be a second
 * place that rule lives.
 */
const TriageEntrySessionLinkDisplayV1Schema = defineProtocolObject({
    locator: TriageEntryLocatorV1Schema,
    scopeLabel: triageText,
}, { policy: 'closed' });

export const TriageLinkEntryToSessionInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    sessionId: triageSessionId,
    entryRef: TriageEntryRefV1Schema,
    display: TriageEntrySessionLinkDisplayV1Schema,
}, { policy: 'closed' });
export type TriageLinkEntryToSessionInputV1 =
    ReturnType<typeof TriageLinkEntryToSessionInputV1Schema.parse>;

export const TriageLinkEntryToSessionActionResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    /**
     * `linked` covers a fresh write and a repeat of the same relationship
     * alike: the link is idempotent by address, so a caller that pressed twice
     * has nothing different to be told. `failed` is the storage boundary
     * refusing or losing the write, and only that phase is retried.
     */
    status: defineProtocolUnion([
        defineProtocolLiteral('linked'),
        defineProtocolLiteral('failed'),
    ]),
}, { policy: 'closed' });
export type TriageLinkEntryToSessionActionResultV1 =
    ReturnType<typeof TriageLinkEntryToSessionActionResultV1Schema.parse>;

/** The durable link write. One Action, one canonical writer beneath it. */
export const TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1 = 'sessions/link-entry-v1';

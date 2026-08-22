import type { PluginJsonSchema, ProtocolComposableSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';

import {
    MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1,
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_INSTANCE_DRAFTS_V1,
    MAX_TRIAGE_INSTANCE_FAILURES_V1,
    TRIAGE_SOURCE_INSTANCE_KEY_STABILITY_V1,
} from './bounds.js';
import { TriageSourceFailureV1Schema } from './diagnostics.js';
import {
    TriageIdentifierV1ProtocolSchema,
    TriageLocationV1ProtocolSchema,
    TriageSourceInstanceRefV1Schema,
    TriageTextV1ProtocolSchema,
} from './identity.js';
import {
    defineTriageCompositeIdentifierStringV1,
    defineTriageSingleLineStringV1,
} from './strings.js';

/**
 * The canonical account ref, re-annotated through a LOCAL structural type.
 *
 * The runtime owner is unchanged and canonical: this is
 * `QualifiedConnectedAccountRefSchema` itself, so validation, JSON Schema and
 * every parse stay the SDK's. Only the TYPE this package EMITS is restated.
 *
 * Why it must be restated: the SDK re-exports that schema from the PRIVATE
 * `@happier-dev/protocol` package, and the inferred `service` member resolves to
 * that package's `PluginContributionIdentityV1`. This package is
 * `private: false` with `dependencies: {}`, so every emitted declaration that
 * transitively contained the ref named a package a consumer can never install —
 * 70 references across 7 files, all of them this one `service` field.
 * `sdkSchemaClosure.test.ts` is the fence.
 *
 * Why the annotation is STRUCTURAL rather than the SDK's `QualifiedConnectedAccountRef`
 * alias, and why it lives on the MEMBER: both were tried and measured.
 * Annotating with the SDK alias only moves the problem — the alias is *declared*
 * in the private package, so TypeScript expands it right back to that import.
 * Annotating the composed schema instead of the member fixes exactly one
 * schema's emit and nothing downstream, because `defineProtocolObject` maps its
 * members structurally: every schema that embeds an unannotated one re-expands
 * the private type (that partial attempt cleared 12 of 70). A structural type
 * declared HERE expands to itself, so the single annotation cascades through
 * every schema that embeds this binding.
 *
 * The shape is lossless, not a widening: `PluginContributionIdentityV1` is
 * `{ pluginId: string; localId: string }` — unbranded — and the protocol package
 * annotates it with this very pattern
 * (`packages/protocol/src/plugins/contributionIdentity.ts:72-75`).
 * Drift is a compile error, not a silent divergence: the initializer below must
 * remain assignable to this annotation.
 *
 * The SDK is NOT the defect and needs no change: it is `private: true` and
 * declares `@happier-dev/protocol` as a real dependency, so naming that package
 * in its own declarations is correct.
 */
const TriageBoundAccountRefV1Schema: ProtocolComposableSchema<Readonly<{
    service: Readonly<{ pluginId: string; localId: string }>;
    accountId: string;
}>> = QualifiedConnectedAccountRefSchema;

/**
 * The exact non-secret source account binding: the descriptor's declared
 * purpose plus one exact account ref returned by that invocation's bounded
 * metadata listing (`CONTRACT.md` §3.1). It stays separate from the
 * source-private configuration so account identity has one carrier.
 */
export const TriageSourceAccountBindingV1Schema = defineProtocolObject({
    purpose: TriageIdentifierV1ProtocolSchema,
    account: TriageBoundAccountRefV1Schema,
}, { policy: 'closed' });
export type TriageSourceAccountBindingV1 = ReturnType<
    typeof TriageSourceAccountBindingV1Schema.parse
>;

/**
 * The bounded source-private configured-instance token. Each source owns a
 * strict versioned encoder/decoder for its bytes; the target bounds, copies,
 * and returns it without parsing, persisting meaning, or granting it authority
 * (`CONTRACT.md` §3.2). It carries no credential, origin, or filesystem path.
 */
export const TriageSourceInstanceConfigurationV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    token: defineTriageSingleLineStringV1(MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1),
}, { policy: 'closed' });
export type TriageSourceInstanceConfigurationV1 = ReturnType<
    typeof TriageSourceInstanceConfigurationV1Schema.parse
>;

/** Mutable presentation of one candidate or configured source instance. */
export const TriageSourceInstanceLocatorV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    displayLabel: TriageTextV1ProtocolSchema,
    displayPath: TriageTextV1ProtocolSchema.optional(),
    webUrl: TriageLocationV1ProtocolSchema.optional(),
}, { policy: 'closed' });
export type TriageSourceInstanceLocatorV1 = ReturnType<
    typeof TriageSourceInstanceLocatorV1Schema.parse
>;

/**
 * @internal Relative-only source-native instance/scope key.
 *
 * It is the second V1 composite identifier: `sources/SENTRY.md` §2.4 pins the
 * Sentry key to `<normalized deploymentOrigin> U+001F <organizationId>`, the
 * same grammar `collisionScope` carries, so it shares that one owner rather
 * than getting a second separator rule. A source that composes more components
 * — PostHog, GitLab, GitHub, Bitbucket, and Azure DevOps all do — uses a
 * printable separator its own components cannot contain, which this grammar
 * already admits.
 */
export const TriageLocalInstanceKeyV1ProtocolSchema = defineTriageCompositeIdentifierStringV1(
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
);

/** @internal Relative-only declared stability of one source-native instance key. */
export const TriageSourceInstanceKeyStabilityV1ProtocolSchema = defineProtocolUnion([
    defineProtocolLiteral(TRIAGE_SOURCE_INSTANCE_KEY_STABILITY_V1[0]),
    defineProtocolLiteral(TRIAGE_SOURCE_INSTANCE_KEY_STABILITY_V1[1]),
]);

/**
 * One discovery candidate: the exact account binding plus the provider-native
 * instance/scope and routing configuration the source could reach.
 *
 * A draft never creates a durable configured instance. `localInstanceKey`
 * encodes only the source-native instance/scope and must not re-encode the
 * purpose or account ref, because the exact binding is already a separate
 * member of the target's matching tuple (`CONTRACT.md` §3.1).
 */
export const TriageSourceInstanceDraftV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    binding: TriageSourceAccountBindingV1Schema,
    localInstanceKey: TriageLocalInstanceKeyV1ProtocolSchema,
    keyStability: TriageSourceInstanceKeyStabilityV1ProtocolSchema,
    configuration: TriageSourceInstanceConfigurationV1Schema,
    locator: TriageSourceInstanceLocatorV1Schema,
}, { policy: 'closed' });
export type TriageSourceInstanceDraftV1 = ReturnType<
    typeof TriageSourceInstanceDraftV1Schema.parse
>;

/**
 * The exact configured instance the target passes to `scan`, `get`, `detail`,
 * and optional review-workspace preparation. `instance` carries the
 * target-minted stable ref; the source reauthorizes `binding.account` on every
 * invocation and never falls through to another authorized account.
 */
export const TriageConfiguredSourceInstanceV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    instance: TriageSourceInstanceRefV1Schema,
    binding: TriageSourceAccountBindingV1Schema,
    localInstanceKey: TriageLocalInstanceKeyV1ProtocolSchema,
    configuration: TriageSourceInstanceConfigurationV1Schema,
    locator: TriageSourceInstanceLocatorV1Schema.optional(),
}, { policy: 'closed' });
export type TriageConfiguredSourceInstanceV1 = ReturnType<
    typeof TriageConfiguredSourceInstanceV1Schema.parse
>;
export const TriageConfiguredSourceInstanceV1JsonSchema: PluginJsonSchema =
    TriageConfiguredSourceInstanceV1Schema.jsonSchema;

/**
 * @internal One exact-binding discovery failure. Without `localInstanceKey` it
 * covers the whole exact binding; with one it covers only that exact
 * binding/key tuple (`CONTRACT.md` §3.1).
 */
export const TriageSourceInstanceFailureV1ProtocolSchema = defineProtocolObject({
    binding: TriageSourceAccountBindingV1Schema,
    localInstanceKey: TriageLocalInstanceKeyV1ProtocolSchema.optional(),
    failure: TriageSourceFailureV1Schema,
}, { policy: 'closed' });

/**
 * `listInstances` carries no binding, account list, cursor, credential, or
 * source policy: the source asks the generic Connected Accounts owner for its
 * own descriptor purpose (`CONTRACT.md` §3.1).
 */
export const TriageListInstancesInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
}, { policy: 'closed' });
export type TriageListInstancesInputV1 = ReturnType<
    typeof TriageListInstancesInputV1Schema.parse
>;

const triageInstanceCandidatesV1 = defineProtocolArray(TriageSourceInstanceDraftV1Schema, {
    maxItems: MAX_TRIAGE_INSTANCE_DRAFTS_V1,
});
const triageInstanceFailuresV1 = defineProtocolArray(TriageSourceInstanceFailureV1ProtocolSchema, {
    maxItems: MAX_TRIAGE_INSTANCE_FAILURES_V1,
});

/**
 * `complete` means account enumeration was complete and per-account instance
 * discovery either finished or has an explicit exact-binding failure.
 * `incomplete` means some account or instance may be unrepresented — including
 * a truncated metadata listing, which the incumbent owner cannot resume, and a
 * bounded discovery cap, whose one top-level `failure` stays representable even
 * when the exact-binding array is already saturated. `failed` means the source
 * learned nothing (`CONTRACT.md` §3.1).
 */
export const TriageListInstancesResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('complete'),
        candidates: triageInstanceCandidatesV1,
        failures: triageInstanceFailuresV1,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('incomplete'),
        candidates: triageInstanceCandidatesV1,
        failures: triageInstanceFailuresV1,
        failure: TriageSourceFailureV1Schema.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('failed'),
        failure: TriageSourceFailureV1Schema,
    }, { policy: 'closed' }),
]);
export type TriageListInstancesResultV1 = ReturnType<
    typeof TriageListInstancesResultV1Schema.parse
>;

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';
import {
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TriageSourceAccountBindingV1Schema,
    TriageSourceFailureV1Schema,
} from '@happier-dev/triage-protocol/v1';

/**
 * PostHog's current REST default page geometry (`posthog/settings/web.py`:
 * `REST_FRAMEWORK.PAGE_SIZE = 100`). This is not a cumulative walk ceiling:
 * every provider continuation remains available through an explicit user request.
 * Keeping the request at the provider's own page size avoids a Triage-only transport
 * quota while still bounding the one response projection the directory returns.
 */
export const MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1 = 100;

const PageSchema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('initial') }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('continuation'),
        next: defineProtocolString({ minLength: 1 }),
    }, { policy: 'closed' }),
]);

const OrganizationUuidSchema = defineProtocolUtf8String({
    minLength: 36,
    maxUtf8Bytes: 36,
});

export const PosthogConfigurationDirectoryInputV1Schema = defineProtocolUnion([
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        kind: defineProtocolLiteral('organizations'),
        binding: TriageSourceAccountBindingV1Schema,
        page: PageSchema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        kind: defineProtocolLiteral('environments'),
        binding: TriageSourceAccountBindingV1Schema,
        organizationUuid: OrganizationUuidSchema,
        page: PageSchema,
    }, { policy: 'closed' }),
]);
export type PosthogConfigurationDirectoryInputV1 = ReturnType<
    typeof PosthogConfigurationDirectoryInputV1Schema.parse
>;

const NextSchema = defineProtocolString({ minLength: 1 }).optional();

const OrganizationSchema = defineProtocolObject({
    organizationUuid: OrganizationUuidSchema,
    displayName: defineProtocolUtf8String({
        minLength: 1,
        maxUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    }),
    localInstanceKey: defineProtocolUtf8String({
        minLength: 1,
        maxUtf8Bytes: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    }),
}, { policy: 'closed' });

const EnvironmentSchema = defineProtocolObject({
    teamPathId: defineProtocolNumber({ integer: true, minimum: 1 }),
    teamUuid: OrganizationUuidSchema,
    parentProjectId: defineProtocolNumber({ integer: true, minimum: 1 }).optional(),
    displayName: defineProtocolUtf8String({
        minLength: 1,
        maxUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    }),
}, { policy: 'closed' });

export const PosthogConfigurationDirectoryResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('organizations'),
        rows: defineProtocolArray(OrganizationSchema, {
            maxItems: MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1,
        }),
        next: NextSchema,
        incomplete: defineProtocolLiteral(true).optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('environments'),
        organizationUuid: OrganizationUuidSchema,
        rows: defineProtocolArray(EnvironmentSchema, {
            maxItems: MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1,
        }),
        next: NextSchema,
        incomplete: defineProtocolLiteral(true).optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('unavailable'),
        failure: TriageSourceFailureV1Schema,
    }, { policy: 'closed' }),
]);
export type PosthogConfigurationDirectoryResultV1 = ReturnType<
    typeof PosthogConfigurationDirectoryResultV1Schema.parse
>;

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';
import {
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TriageSourceAccountBindingV1Schema,
    TriageSourceFailureV1Schema,
} from '@happier-dev/triage-protocol/v1';

/** The shipped plugin HTTP boundary rejects request URLs wider than 8 KiB. */
export const MAX_POSTHOG_DIRECTORY_NEXT_URL_UTF8_BYTES_V1 = 8 * 1024;

/**
 * Rows per directory page, derived from the 1 MiB Action JSON boundary with the widest
 * valid organization row and widest continuation URL. `configurationContract.test.ts`
 * proves 754 fits and 755 does not. This bounds one response projection only; explicit
 * user-driven continuations have no cumulative page count.
 */
export const MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1 = 754;

const PageSchema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('initial') }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('continuation'),
        next: defineProtocolUtf8String({
            minLength: 1,
            maxUtf8Bytes: MAX_POSTHOG_DIRECTORY_NEXT_URL_UTF8_BYTES_V1,
        }),
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

const NextSchema = defineProtocolUtf8String({
    minLength: 1,
    maxUtf8Bytes: MAX_POSTHOG_DIRECTORY_NEXT_URL_UTF8_BYTES_V1,
}).optional();

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

import { z } from 'zod';

const connectedServiceLimitCategoryCanonicalValues = [
    'usage_limit',
    'rate_limit',
    'capacity',
    'temporary_throttle',
    'auth_invalid',
    'plan_invalid',
    'validation_failed',
    'disabled',
    'unknown',
] as const;

const connectedServiceLimitCategoryLegacyAliasValues = [
    'quota',
    'auth',
    'plan',
    'validation',
    'account_disabled',
] as const;

const ConnectedServiceLimitCategoryCanonicalSchema = z.enum(connectedServiceLimitCategoryCanonicalValues);
const ConnectedServiceLimitCategoryLegacyAliasSchema = z.enum(connectedServiceLimitCategoryLegacyAliasValues);

export type ConnectedServiceLimitCategoryV1 = z.infer<typeof ConnectedServiceLimitCategoryCanonicalSchema>;
export type ConnectedServiceLimitCategoryLegacyAliasV1 = z.infer<typeof ConnectedServiceLimitCategoryLegacyAliasSchema>;
export type ConnectedServiceLimitCategoryInputV1 =
    | ConnectedServiceLimitCategoryV1
    | ConnectedServiceLimitCategoryLegacyAliasV1;

export function normalizeConnectedServiceLimitCategoryV1(
    value: ConnectedServiceLimitCategoryInputV1,
): ConnectedServiceLimitCategoryV1 {
    switch (value) {
        case 'quota':
            return 'usage_limit';
        case 'auth':
            return 'auth_invalid';
        case 'plan':
            return 'plan_invalid';
        case 'validation':
            return 'validation_failed';
        case 'account_disabled':
            return 'disabled';
        default:
            return value;
    }
}

export function readConnectedServiceLimitCategoryV1(value: unknown): ConnectedServiceLimitCategoryV1 | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = ConnectedServiceLimitCategoryV1Schema.safeParse(trimmed);
    return parsed.success ? parsed.data : null;
}

export const ConnectedServiceLimitCategoryV1Schema = z
    .union([
        ConnectedServiceLimitCategoryCanonicalSchema,
        ConnectedServiceLimitCategoryLegacyAliasSchema,
    ])
    .transform(normalizeConnectedServiceLimitCategoryV1);

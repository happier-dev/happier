import type { AppVariant } from '@/sync/runtime/appVariant';

function toOptionalNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

const HAPPIER_CLI_NPM_PACKAGE = '@happier-dev/cli' as const;

export function resolveHappierCliNpmPackageSpecifier(input: Readonly<{ appVariant: AppVariant; distTagOverride?: unknown }>): string {
    const override = input.distTagOverride === undefined ? undefined : toOptionalNonEmptyString(input.distTagOverride);

    const distTag =
        override !== undefined
            ? override
            : input.appVariant === 'production'
                ? null
                : 'next';

    return distTag ? `${HAPPIER_CLI_NPM_PACKAGE}@${distTag}` : HAPPIER_CLI_NPM_PACKAGE;
}

import type { AppVariant } from '@/sync/runtime/appVariant';

function toOptionalNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveInstallChannel(input: Readonly<{ appVariant: AppVariant; distTagOverride?: unknown }>): 'stable' | 'preview' {
    const override = input.distTagOverride === undefined ? undefined : toOptionalNonEmptyString(input.distTagOverride);
    if (override === 'next' || override === 'preview') return 'preview';
    if (input.appVariant === 'production') return 'stable';
    return 'preview';
}

export function buildHappierCliInstallCommand(input: Readonly<{ appVariant: AppVariant; distTagOverride?: unknown }>): string {
    const channel = resolveInstallChannel(input);
    if (channel === 'preview') {
        return 'curl -fsSL https://happier.dev/install | bash -s -- --channel preview';
    }
    return 'curl -fsSL https://happier.dev/install | bash';
}

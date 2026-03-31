import { config } from '@/config';
import { resolveAppVariant } from '@/sync/runtime/appVariant';

import { buildHappierCliInstallCommand } from '@/components/sessions/guidance/happierCliInstallCommand';

export function buildCliInstallCommandForCurrentApp(): string {
    const appVariant = resolveAppVariant({
        appVariant: config.variant,
        envAppEnv: process.env.APP_ENV,
        envExpoPublicAppEnv: process.env.EXPO_PUBLIC_APP_ENV,
    }) ?? 'production';

    return buildHappierCliInstallCommand({
        appVariant,
        distTagOverride: config.cliNpmDistTag,
    });
}

export function buildAuthLoginCommandForServerUrl(serverUrl: string): string {
    const trimmed = String(serverUrl).trim();
    if (!trimmed) return 'happier auth login';
    return `happier auth login --server-url ${trimmed} --persist --method web`;
}


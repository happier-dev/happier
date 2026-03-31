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

export function buildHappierSetupCommand(params: Readonly<{
    relayUrl: string | null;
    skipDaemon?: boolean;
    skipProviders?: boolean;
    yes?: boolean;
}>): string {
    const relayUrl = String(params.relayUrl ?? '').trim();
    const base = relayUrl ? `happier setup --relay-url ${relayUrl}` : 'happier setup';
    const flags: string[] = [];
    if (params.skipDaemon) flags.push('--skip-daemon');
    if (params.skipProviders) flags.push('--skip-providers');
    if (params.yes) flags.push('--yes');
    return flags.length > 0 ? `${base} ${flags.join(' ')}` : base;
}

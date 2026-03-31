import { config } from '@/config';
import type { SshCredentialsDraft } from '@/components/settings/machines/shared/SshCredentialsFields';
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

function buildRemoteSshArgs(params: Readonly<{
    draft: SshCredentialsDraft;
    installRelayRuntime?: boolean;
}>): string[] {
    const username = params.draft.username.trim();
    const host = params.draft.host.trim();
    const port = params.draft.port.trim();
    const identityFilePath = params.draft.identityFilePath.trim();
    const args: string[] = [
        `--ssh-user ${username || '<user>'}`,
        `--ssh-host ${host || '<host>'}`,
    ];
    if (port) {
        args.push(`--ssh-port ${port}`);
    }
    args.push(`--ssh-auth ${params.draft.authMode}`);
    if (params.draft.authMode === 'keyfile' && identityFilePath) {
        args.push(`--identity-file ${identityFilePath}`);
    }
    if (params.installRelayRuntime) {
        args.push('--install-relay-runtime');
    }
    return args;
}

export function buildRemoteMachineSetupCommand(params: Readonly<{
    draft: SshCredentialsDraft;
    installRelayRuntime?: boolean;
}>): string {
    return [
        'happier machine setup',
        ...buildRemoteSshArgs(params),
        '--yes',
    ].join(' ');
}

export function buildRemoteRelayHostInstallCommand(params: Readonly<{
    draft: SshCredentialsDraft;
    installRelayRuntime?: boolean;
}>): string {
    return [
        'happier relay host install',
        '--mode user',
        ...buildRemoteSshArgs(params),
        '--yes',
    ].join(' ');
}

export function buildRemoteRelayHostStatusCommand(params: Readonly<{
    draft: SshCredentialsDraft;
}>): string {
    return [
        'happier relay host status',
        ...buildRemoteSshArgs({ draft: params.draft }),
        '--json',
    ].join(' ');
}

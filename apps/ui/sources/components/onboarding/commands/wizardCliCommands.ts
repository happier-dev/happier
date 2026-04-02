import { config } from '@/config';
import type { SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { resolveAppVariant } from '@/sync/runtime/appVariant';
import { resolveCliInvokerNameForCurrentApp, resolvePreferredPublicReleaseRingIdForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';

import {
    buildHappierCliInstallAndRunCommand,
    buildHappierCliInstallCommand,
    buildHappierCliInstallAndRunPowershellCommand,
    buildHappierCliInstallPowershellCommand,
    type HappierInstallerRunAction,
} from '@/components/sessions/guidance/happierCliInstallCommand';

export { resolveCliInvokerNameForCurrentApp };

export function buildCliInstallCommandForCurrentApp(): string {
    const appVariant = resolveAppVariant({
        appVariant: config.variant,
        envAppEnv: process.env.APP_ENV,
        envExpoPublicAppEnv: process.env.EXPO_PUBLIC_APP_ENV,
    }) ?? 'production';
    const publicReleaseRingOverride = resolvePreferredPublicReleaseRingIdForCurrentApp();

    return buildHappierCliInstallCommand({
        appVariant,
        distTagOverride: config.cliNpmDistTag,
        publicReleaseRingOverride,
    });
}

export function buildCliInstallPowershellCommandForCurrentApp(): string {
    const appVariant = resolveAppVariant({
        appVariant: config.variant,
        envAppEnv: process.env.APP_ENV,
        envExpoPublicAppEnv: process.env.EXPO_PUBLIC_APP_ENV,
    }) ?? 'production';
    const publicReleaseRingOverride = resolvePreferredPublicReleaseRingIdForCurrentApp();

    return buildHappierCliInstallPowershellCommand({
        appVariant,
        distTagOverride: config.cliNpmDistTag,
        publicReleaseRingOverride,
    });
}

export function buildCliInstallAndRunCommandForCurrentApp(run: Readonly<{
    action: HappierInstallerRunAction;
    args?: readonly string[];
}>): string {
    const appVariant = resolveAppVariant({
        appVariant: config.variant,
        envAppEnv: process.env.APP_ENV,
        envExpoPublicAppEnv: process.env.EXPO_PUBLIC_APP_ENV,
    }) ?? 'production';
    const publicReleaseRingOverride = resolvePreferredPublicReleaseRingIdForCurrentApp();

    return buildHappierCliInstallAndRunCommand({
        appVariant,
        distTagOverride: config.cliNpmDistTag,
        publicReleaseRingOverride,
    }, run);
}

export function buildCliInstallAndRunPowershellCommandForCurrentApp(run: Readonly<{
    action: HappierInstallerRunAction;
    args?: readonly string[];
}>): string {
    const appVariant = resolveAppVariant({
        appVariant: config.variant,
        envAppEnv: process.env.APP_ENV,
        envExpoPublicAppEnv: process.env.EXPO_PUBLIC_APP_ENV,
    }) ?? 'production';
    const publicReleaseRingOverride = resolvePreferredPublicReleaseRingIdForCurrentApp();

    return buildHappierCliInstallAndRunPowershellCommand({
        appVariant,
        distTagOverride: config.cliNpmDistTag,
        publicReleaseRingOverride,
    }, run);
}

export function buildAuthLoginCommandForServerUrl(serverUrl: string): string {
    const invoker = resolveCliInvokerNameForCurrentApp();
    const trimmed = String(serverUrl).trim();
    if (!trimmed) return `${invoker} auth login`;
    return `${invoker} auth login --server-url ${trimmed} --persist --method web`;
}

export function buildHappierSetupCommand(params: Readonly<{
    relayUrl: string | null;
    skipDaemon?: boolean;
    skipProviders?: boolean;
    yes?: boolean;
}>): string {
    const invoker = resolveCliInvokerNameForCurrentApp();
    const relayUrl = String(params.relayUrl ?? '').trim();
    const base = relayUrl ? `${invoker} setup --relay-url ${relayUrl}` : `${invoker} setup`;
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
    const invoker = resolveCliInvokerNameForCurrentApp();
    return [
        `${invoker} machine setup`,
        ...buildRemoteSshArgs(params),
        '--yes',
    ].join(' ');
}

export function buildRemoteRelayHostInstallCommand(params: Readonly<{
    draft: SshCredentialsDraft;
    installRelayRuntime?: boolean;
}>): string {
    const invoker = resolveCliInvokerNameForCurrentApp();
    return [
        `${invoker} relay host install`,
        '--mode user',
        ...buildRemoteSshArgs(params),
        '--yes',
    ].join(' ');
}

export function buildRemoteRelayHostStatusCommand(params: Readonly<{
    draft: SshCredentialsDraft;
}>): string {
    const invoker = resolveCliInvokerNameForCurrentApp();
    return [
        `${invoker} relay host status`,
        ...buildRemoteSshArgs({ draft: params.draft }),
        '--json',
    ].join(' ');
}

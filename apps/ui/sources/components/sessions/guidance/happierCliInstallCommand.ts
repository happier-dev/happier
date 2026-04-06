import type { AppVariant } from '@/sync/runtime/appVariant';
import { resolvePublicReleaseRingLabelForId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

function toOptionalNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveInstallChannel(input: Readonly<{
    appVariant: AppVariant;
    distTagOverride?: unknown;
    publicReleaseRingOverride?: PublicReleaseRingId;
}>): 'stable' | 'preview' | 'dev' {
    if (input.publicReleaseRingOverride) {
        return resolvePublicReleaseRingLabelForId(input.publicReleaseRingOverride);
    }
    const override = input.distTagOverride === undefined ? undefined : toOptionalNonEmptyString(input.distTagOverride);
    if (override === 'next' || override === 'preview') return 'preview';
    if (input.appVariant === 'production') return 'stable';
    return 'preview';
}

export function buildHappierCliInstallCommand(input: Readonly<{
    appVariant: AppVariant;
    distTagOverride?: unknown;
    publicReleaseRingOverride?: PublicReleaseRingId;
}>): string {
    const channel = resolveInstallChannel(input);
    if (channel === 'preview') {
        return 'curl -fsSL https://happier.dev/install | bash -s -- --channel preview';
    }
    if (channel === 'dev') {
        return 'curl -fsSL https://happier.dev/install | bash -s -- --channel dev';
    }
    return 'curl -fsSL https://happier.dev/install | bash';
}

export type HappierInstallerRunAction =
    | 'setup-relay'
    | 'setup'
    | 'auth-login'
    | 'daemon-install'
    | 'providers-setup';

function buildPowershellInstallerInvocation(input: Readonly<{
    channel: 'stable' | 'preview' | 'dev';
}>): string {
    const base = '& ([ScriptBlock]::Create((irm https://happier.dev/install.ps1)))';
    if (input.channel === 'preview') return `${base} -Channel preview`;
    if (input.channel === 'dev') return `${base} -Channel dev`;
    return base;
}

function resolveCliInvokerNameForChannel(channel: 'stable' | 'preview' | 'dev'): 'happier' | 'hprev' | 'hdev' {
    if (channel === 'preview') return 'hprev';
    if (channel === 'dev') return 'hdev';
    return 'happier';
}

function buildCliRunCommandForChannel(
    channel: 'stable' | 'preview' | 'dev',
    run: Readonly<{
        action: HappierInstallerRunAction;
        args?: readonly string[];
    }>,
): string {
    const invoker = resolveCliInvokerNameForChannel(channel);
    const args = Array.isArray(run.args) && run.args.length > 0 ? ` ${run.args.join(' ')}` : '';

    switch (run.action) {
        case 'setup':
            return `${invoker} setup${args}`;
        case 'auth-login':
            return `${invoker} auth login${args}`;
        case 'providers-setup':
            return `${invoker} providers setup${args}`;
        default:
            return `${invoker} ${run.action}${args}`;
    }
}

export function buildHappierCliInstallAndRunCommand(
    input: Readonly<{
        appVariant: AppVariant;
        distTagOverride?: unknown;
        publicReleaseRingOverride?: PublicReleaseRingId;
    }>,
    run: Readonly<{
        action: HappierInstallerRunAction;
        args?: readonly string[];
    }>,
): string {
    const channel = resolveInstallChannel(input);
    const args: string[] = [];

    if (channel === 'preview') args.push('--channel preview');
    if (channel === 'dev') args.push('--channel dev');

    if (run.action === 'setup-relay') {
        args.push('--setup-relay');
    } else {
        return `curl -fsSL https://happier.dev/install | bash -s -- ${args.join(' ')}`.trim()
            + ` && ${buildCliRunCommandForChannel(channel, run)}`;
    }

    return `curl -fsSL https://happier.dev/install | bash -s -- ${args.join(' ')}`.trim();
}

export function buildHappierCliInstallPowershellCommand(input: Readonly<{
    appVariant: AppVariant;
    distTagOverride?: unknown;
    publicReleaseRingOverride?: PublicReleaseRingId;
}>): string {
    const channel = resolveInstallChannel(input);
    return buildPowershellInstallerInvocation({ channel });
}

export function buildHappierCliInstallAndRunPowershellCommand(
    input: Readonly<{
        appVariant: AppVariant;
        distTagOverride?: unknown;
        publicReleaseRingOverride?: PublicReleaseRingId;
    }>,
    run: Readonly<{
        action: HappierInstallerRunAction;
        args?: readonly string[];
    }>,
): string {
    const channel = resolveInstallChannel(input);
    const parts: string[] = [buildPowershellInstallerInvocation({ channel })];

    if (run.action === 'setup-relay') {
        parts.push('-SetupRelay');
        return parts.join(' ');
    }

    return `${parts.join(' ')}; if ($?) { ${buildCliRunCommandForChannel(channel, run)} }`;
}

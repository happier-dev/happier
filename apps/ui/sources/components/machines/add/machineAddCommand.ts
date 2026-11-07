import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';
import type { ManagedMachineEnrollmentIdentityV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ServerProfileSource } from '@/sync/domains/server/serverProfiles';
import type { SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { config } from '@/config';
import { resolveAppVariant } from '@/sync/runtime/appVariant';
import { resolvePreferredPublicReleaseRingIdForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import {
    buildHappierCliInstallAndRunCommand,
    buildHappierCliInstallAndRunPowershellCommand,
} from '@/components/sessions/guidance/happierCliInstallCommand';

export const MACHINE_ADD_COMMAND_OS = ['macos', 'linux', 'windows'] as const;
export type MachineAddCommandOs = typeof MACHINE_ADD_COMMAND_OS[number];
export type WebDesktopSetupHandoffTarget =
    | Readonly<{ kind: 'https'; homeUrl: string }>
    | Readonly<{ kind: 'account_service' }>
    | Readonly<{ kind: 'descriptor_file_required' }>;
export type MachineAddHomeTarget = Readonly<{
    descriptor: HomeConnectionDescriptorV1 | null;
    profileSource: ServerProfileSource | null;
    fallbackHomeUrl: string | null;
}>;

/** A descriptor without HTTPS needs a file; the installer's stdin cannot carry it. */
export function resolveWebDesktopSetupHandoffTarget(params: MachineAddHomeTarget): WebDesktopSetupHandoffTarget {
    if (params.descriptor) {
        const https = params.descriptor.endpoints.find((endpoint) => endpoint.kind === 'https');
        return https ? { kind: 'https', homeUrl: https.url } : { kind: 'descriptor_file_required' };
    }
    const url = String(params.fallbackHomeUrl ?? '').trim();
    return url ? { kind: 'https', homeUrl: url } : { kind: 'account_service' };
}

export function detectClientCommandOs(userAgent: string | null = typeof navigator === 'undefined' ? null : navigator.userAgent): MachineAddCommandOs | null {
    if (!userAgent || /Android|iPhone|iPad|iPod/i.test(userAgent)) return null;
    if (/Windows/i.test(userAgent)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
    if (/Linux/i.test(userAgent)) return 'linux';
    return null;
}

export type MachineAddCommandInput = MachineAddHomeTarget & Readonly<{
    os: MachineAddCommandOs;
}> & (Readonly<{ kind: 'joinHome'; skipProviders?: boolean }>
    | Readonly<{ kind: 'sshMachine'; sshDraft: SshCredentialsDraft; enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1 }>);

function quoteShellValue(value: string, os: MachineAddCommandOs): string {
    if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) return value;
    return os === 'windows' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function buildMachineAddCommand(input: MachineAddCommandInput): string {
    const target = resolveWebDesktopSetupHandoffTarget(input);
    const args = target.kind === 'https' ? ['--home-url', target.homeUrl]
        : target.kind === 'descriptor_file_required' ? ['--home-descriptor-file', './happier-home.json'] : [];
    if (input.kind === 'joinHome') {
        if (input.skipProviders) args.push('--skip-providers');
    } else {
        const draft = input.sshDraft;
        args.push('--ssh-host', draft.host.trim());
        if (draft.username.trim()) args.push('--ssh-user', draft.username.trim());
        if (draft.port.trim()) args.push('--ssh-port', draft.port.trim());
        args.push('--ssh-auth', draft.authMode);
        if (draft.authMode === 'keyfile') args.push('--identity-file', draft.identityFilePath.trim());
        const identity = input.enrollmentIdentity;
        // Keep the public installer's personal command usable by older released CLIs.
        if (identity) args.push('--role', identity.role);
        if (identity?.kind === 'dedicatedDaemonUser') {
            args.push('--admin-access', identity.adminAccessAtCreation);
            if (identity.adminAccessAtCreation === 'ask' && identity.administrator) {
                args.push('--administrator', identity.administrator.username);
            }
        }
        args.push('--yes');
    }
    const options = {
        appVariant: resolveAppVariant({ appVariant: config.variant, envAppEnv: process.env.APP_ENV, envExpoPublicAppEnv: process.env.EXPO_PUBLIC_APP_ENV }) ?? 'production',
        distTagOverride: config.cliNpmDistTag,
        publicReleaseRingOverride: resolvePreferredPublicReleaseRingIdForCurrentApp(),
    };
    return (input.os === 'windows' ? buildHappierCliInstallAndRunPowershellCommand : buildHappierCliInstallAndRunCommand)(options, {
        action: input.kind === 'joinHome' ? 'setup' : 'machine-enroll',
        args: args.map((arg) => quoteShellValue(arg, input.os)),
    });
}

import type { BackendCommandRunResult as ScmBackendCommandRunResult } from '@happier-dev/plugin-sdk/scm/backend';

type ScmBackendContributionToolCommand = Readonly<{
    installableKey: string;
    command: string;
}>;

export type ScmInstallableCommandAuthorization = ReadonlyMap<string, ReadonlySet<string>>;

const FIRST_PARTY_SCM_TOOL_COMMANDS: readonly ScmBackendContributionToolCommand[] = [
    { installableKey: 'dep.git', command: 'git' },
    { installableKey: 'dep.sapling', command: 'sl' },
] as const;

export const FIRST_PARTY_SCM_COMMAND_AUTHORIZATION = createScmInstallableCommandAuthorization(
    FIRST_PARTY_SCM_TOOL_COMMANDS,
);

export function createScmInstallableCommandAuthorization(
    commands: readonly ScmBackendContributionToolCommand[],
): ScmInstallableCommandAuthorization {
    const mutable = new Map<string, Set<string>>();
    for (const command of commands) {
        const installableKey = command.installableKey.trim();
        const executable = command.command.trim();
        if (!installableKey || !executable) continue;
        const existing = mutable.get(installableKey) ?? new Set<string>();
        existing.add(executable);
        mutable.set(installableKey, existing);
    }
    return new Map([...mutable.entries()].map(([installableKey, allowedCommands]) => [
        installableKey,
        new Set(allowedCommands),
    ]));
}

export function rejectUnauthorizedScmInstallableCommand(input: Readonly<{
    installableKey: string;
    command: string;
    authorization?: ScmInstallableCommandAuthorization;
}>): ScmBackendCommandRunResult | null {
    const authorization = input.authorization ?? FIRST_PARTY_SCM_COMMAND_AUTHORIZATION;
    const authorizedCommands = authorization.get(input.installableKey);
    if (authorizedCommands?.has(input.command)) {
        return null;
    }

    return {
        success: false,
        stdout: '',
        stderr: `Installable '${input.installableKey}' does not authorize SCM command '${input.command}'`,
        exitCode: -1,
    };
}

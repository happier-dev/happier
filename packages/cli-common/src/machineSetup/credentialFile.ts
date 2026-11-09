import type { MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

/** Shared native parent for invocation-scoped connector credentials. */
export const machineConnectorCredentialDirectory = {
    id: 'access-provider-credential-directory', kind: 'directory', path: '/run/happier-machine-credentials',
    owner: 'root', group: 'root', mode: 0o700, protectedAncestors: true,
} as const satisfies Extract<MachineRecipeStepV1, { kind: 'directory' }>;

export function machineConnectorCredentialFilePath(installationId: string): string {
    return `${machineConnectorCredentialDirectory.path}/${encodeURIComponent(installationId)}.setup-key`;
}

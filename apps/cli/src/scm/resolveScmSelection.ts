import { resolve } from 'node:path';

import type { ScmBackendPreference } from '@happier-dev/protocol';

import type { ScmBackendSelection } from './registry';
import type { ScmBackendContext, ScmConnectedAccountCredentialResolver } from './types';
import type { ScmBackendRegistry } from './registry';

export type ResolvedScmSelection = Readonly<{
    selection: ScmBackendSelection;
    context: ScmBackendContext;
}>;

export async function resolveScmSelection(input: Readonly<{
    workingDirectory: string;
    cwd: string;
    backendPreference?: ScmBackendPreference;
    registry: ScmBackendRegistry;
    connectedAccounts?: ScmConnectedAccountCredentialResolver;
}>): Promise<ResolvedScmSelection | null> {
    const selection = await input.registry.selectBackend({
        cwd: input.cwd,
        workingDirectory: input.workingDirectory,
        backendPreference: input.backendPreference,
    });
    if (!selection) {
        return null;
    }

    return {
        selection,
        context: {
            cwd: input.cwd,
            projectKey: `${resolve(input.workingDirectory)}:${input.cwd}`,
            detection: selection.detection,
            ...(input.connectedAccounts ? { connectedAccounts: input.connectedAccounts } : {}),
        } satisfies ScmBackendContext,
    };
}

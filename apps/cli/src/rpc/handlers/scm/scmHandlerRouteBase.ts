import type { ScmFilesystemAccessPolicy } from '@/scm/runtime';
import type { ScmBackendRegistry } from '@/scm/registry';
import type { ScmConnectedAccountCredentialResolver } from '@/scm/types';

export type ScmHandlerRouteBase = Readonly<{
    workingDirectory: string;
    accessPolicy?: ScmFilesystemAccessPolicy;
    connectedAccounts?: ScmConnectedAccountCredentialResolver;
    /**
     * Optional backend-registry override (dispatch falls back to the default
     * registry when absent). Exists so tests can drive the live registration
     * path with a capability-less backend.
     */
    registry?: ScmBackendRegistry;
}>;

export type ScmMutatingRouteRunner = <TResponse>(
    run: () => Promise<TResponse>,
) => Promise<TResponse>;

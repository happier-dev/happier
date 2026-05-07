import type { ScmFilesystemAccessPolicy } from '@/scm/runtime';
import type { ScmConnectedAccountCredentialResolver } from '@/scm/types';

export type ScmHandlerRouteBase = Readonly<{
    workingDirectory: string;
    accessPolicy?: ScmFilesystemAccessPolicy;
    connectedAccounts?: ScmConnectedAccountCredentialResolver;
}>;

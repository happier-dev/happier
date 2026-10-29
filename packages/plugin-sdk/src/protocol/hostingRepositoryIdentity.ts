import { ScmHostingRepositoryIdentityV1ProtocolSchema as canonicalIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';

export type ProtocolScmHostingProviderKind = ScmHostingProviderRef['kind'];

export type ScmHostingProviderKind = ProtocolScmHostingProviderKind;

export type ScmHostingProviderRef = {
    [key: string]: unknown;
    id: string;
    kind: 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'custom' | 'unknown';
    displayName: string;
    baseUrl: string;
    nameWithOwner?: string;
    repositoryWebUrl?: string;
    remoteName?: string;
    urlSafety: {
        [key: string]: unknown;
        allowedSchemes: string[];
    };
};

export type ScmHostingRepositoryIdentityV1<
    TKind extends ProtocolScmHostingProviderKind = ProtocolScmHostingProviderKind,
> = Readonly<{
    kind: TKind;
    deployment: string;
    repository: string;
}>;
import type { ProtocolComposableSchema } from './protocolFacade.js';

/** The SCM owner's exact repository admission, composable in feature protocols. */
export const ScmHostingRepositoryIdentityV1ProtocolSchema: ProtocolComposableSchema<Readonly<{
    kind: ScmHostingProviderRef['kind'];
    deployment: string;
    repository: string;
}>> = canonicalIdentity;

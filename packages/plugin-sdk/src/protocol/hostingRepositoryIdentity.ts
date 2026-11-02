import type { ScmHostingProviderKind as ProtocolScmHostingProviderKind } from '../scm/hostingProvider.js';
import { ScmHostingRepositoryIdentityV1ProtocolSchema as canonicalIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';

export type { ScmHostingProviderKind, ScmHostingProviderKind as ProtocolScmHostingProviderKind } from '../scm/hostingProvider.js';

export type { ScmHostingProviderRef } from '../scm/hostingProvider.js';

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
    kind: ProtocolScmHostingProviderKind;
    deployment: string;
    repository: string;
}>> = canonicalIdentity;

import type { ArtifactPublicLinkIssuedV1 } from '@happier-dev/protocol/actions/executor/artifactPublicLinkActions';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Immediate dispatch and approval replay deliver privately through the answering App. */
export function createUiArtifactPublicLinkDelivery(account: LazyActionAccountContext) {
    return async (issued: ArtifactPublicLinkIssuedV1): Promise<void> => {
        const { showIssuedDocumentLink } = await import('@/components/sharing/documents/showDocumentShareSheet');
        account.assertCurrent();
        showIssuedDocumentLink({ shareUrl: issued.url, audience: issued.audience,
            scope: { serverId: account.serverId, accountId: account.accountId } });
    };
}

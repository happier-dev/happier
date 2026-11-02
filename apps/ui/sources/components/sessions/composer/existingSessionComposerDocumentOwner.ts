import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';

import type { MutableComposerDocumentOwner } from './composerDocumentOwner';
import { createRepositoryComposerDocumentOwner } from './repositoryComposerDocumentOwner';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Session } from '@/sync/domains/state/storageTypes';

/** Exact Session facts read under the invoking Account, including an inactive Home. */
export type SessionComposerDocumentBinding = Readonly<{
    scope: ServerAccountScope;
    session: Pick<Session, 'id' | 'access' | 'active'>;
    isCurrent: () => boolean;
}>;

export function createExistingSessionComposerDocumentOwner(input: Readonly<{
    scope: ServerAccountScope;
    ref: Extract<ComposerRefV1, { kind: 'session' }>;
    isCurrent?: () => boolean;
}>): MutableComposerDocumentOwner {
    return createRepositoryComposerDocumentOwner(input);
}

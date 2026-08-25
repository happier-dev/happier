import type { ComposerRefV1 } from '@happier-dev/protocol';

import type { ComposerDocumentOwner } from './composerDocumentOwner';
import { createRepositoryComposerDocumentOwner } from './repositoryComposerDocumentOwner';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export function createNewSessionComposerDocumentOwner(input: Readonly<{
    scope: ServerAccountScope;
    ref: Extract<ComposerRefV1, { kind: 'newSession' }>;
    isCurrent?: () => boolean;
}>): ComposerDocumentOwner {
    return createRepositoryComposerDocumentOwner(input);
}

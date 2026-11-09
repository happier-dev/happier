import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';

import type { MutableComposerDocumentOwner } from './composerDocumentOwner';
import { createRepositoryComposerDocumentOwner } from './repositoryComposerDocumentOwner';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export function createNewSessionComposerDocumentOwner(input: Readonly<{
    scope: ServerAccountScope;
    scopeLifetime?: ServerAccountScopeLifetime;
    ref: Extract<ComposerRefV1, { kind: 'newSession' }>;
    isCurrent?: () => boolean;
}>): MutableComposerDocumentOwner {
    return createRepositoryComposerDocumentOwner(input);
}

import type { ComposerCapabilitiesV1} from '@happier-dev/protocol/plugins/ui/composer';
import type { ComposerRefV1} from '@happier-dev/protocol/plugins/ui/composerRef';
import type { SessionDraftAddressV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import * as React from 'react';

import { readServerAccountScopeOwnerLifetime, serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { createEphemeralComposerDocumentOwner, type ComposerDraftDocument, type MutableComposerDocumentOwner } from './composerDocumentOwner';
import { createRepositoryComposerDocumentOwner } from './repositoryComposerDocumentOwner';

type RepositoryAddress = Extract<SessionDraftAddressV2, { kind: 'session' | 'run' | 'newSession' }>;

function addressKey(address: RepositoryAddress): string {
    if (address.kind === 'newSession') return `new:${address.draftId}`;
    if (address.kind === 'run') return `run:${address.sessionId}:${address.runId}`;
    return `session:${address.sessionId}`;
}

/** React lifetime adapter over the existing synchronized draft owner. */
export function useRepositoryComposerDocumentOwner(input: Readonly<{
    scopeLifetime: ServerAccountScopeLifetime | null;
    ref: Extract<ComposerRefV1, { kind: 'session' | 'newSession' | 'participantMessage' }>;
    address: RepositoryAddress | null;
    launcherDraftKey?: string;
    capabilities: ComposerCapabilitiesV1;
    isCurrent?: () => boolean;
    onDocumentChange?: (document: ComposerDraftDocument) => void;
    onDocumentEdit?: () => void;
}>): MutableComposerDocumentOwner {
    const latestInputRef = React.useRef(input);
    latestInputRef.current = input;
    const scopeLifetime = input.scopeLifetime ? readServerAccountScopeOwnerLifetime(input.scopeLifetime) : null;
    const scope = scopeLifetime?.scope ?? null;
    const refKey = input.ref.kind === 'newSession'
        ? `new:${input.ref.instanceId}`
        : input.ref.kind === 'participantMessage'
            ? `participant:${input.ref.sessionId}:${input.ref.instanceId}`
            : `session:${input.ref.sessionId}`;
    const key = scope && input.address
        ? `repository:${serverAccountScopeKeySuffix(scope)}:${addressKey(input.address)}:${input.launcherDraftKey ?? ''}:${refKey}`
        : `ephemeral:${refKey}`;
    const stateRef = React.useRef<Readonly<{ key: string; scopeLifetime: ServerAccountScopeLifetime | null; owner: MutableComposerDocumentOwner }> | null>(null);
    if (!stateRef.current || stateRef.current.key !== key || stateRef.current.scopeLifetime !== scopeLifetime) {
        const owner = scope && input.address
            ? createRepositoryComposerDocumentOwner({
                scope,
                scopeLifetime: scopeLifetime ?? undefined,
                ref: input.ref,
                address: input.address,
                launcherDraftKey: input.launcherDraftKey,
                onDocumentEdit: () => latestInputRef.current.onDocumentEdit?.(),
                isCurrent: () => latestInputRef.current.isCurrent?.() ?? true,
            })
            : createEphemeralComposerDocumentOwner({
                ref: input.ref,
                capabilities: input.capabilities,
                isCurrent: () => latestInputRef.current.isCurrent?.() ?? true,
                onDocumentChange: (document) => latestInputRef.current.onDocumentChange?.(document),
            });
        stateRef.current = { key, scopeLifetime, owner };
    }
    const owner = stateRef.current.owner;
    React.useSyncExternalStore(owner.observe, () => owner.read().revision, () => owner.read().revision);
    const repositoryBacked = scope !== null && input.address !== null;
    React.useEffect(() => {
        if (!repositoryBacked) return undefined;
        latestInputRef.current.onDocumentChange?.(owner.read().document);
        return owner.observe(() => {
            latestInputRef.current.onDocumentChange?.(owner.read().document);
        });
    }, [owner, repositoryBacked]);
    return owner;
}

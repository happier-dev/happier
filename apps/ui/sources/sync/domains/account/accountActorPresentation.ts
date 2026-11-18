import type { TranscriptAccountActor } from '@happier-dev/session-core/messages';
import { classifyAccountActorLabelV1, type AccountActorLabelClassificationV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

/** The one generic label for an Account whose sanitized actor is unavailable. */
export function resolveUnknownAccountActorName(form: 'value' | 'sentence'): string {
    return form === 'sentence'
        ? t('session.collaboration.discussion.attribution.anotherPerson')
        : t('detailPages.approval.requester.anotherPerson');
}

function localizeAccountActorLabel(classification: AccountActorLabelClassificationV1): string {
    switch (classification.kind) {
        case 'former': return t('message.accountActorFormerMember');
        case 'self': return t('message.accountActorYou');
        case 'profile': return classification.label;
        case 'unnamed': return t('message.accountActorUnnamedMember');
    }
}

/** The sole self/name/former-member decision, usable before a wire actor is Home-qualified. */
export function resolveAccountActorName(actor: Pick<TranscriptAccountActor, 'profile' | 'accessibility'>, isSelf: boolean): string {
    return localizeAccountActorLabel(classifyAccountActorLabelV1(actor, isSelf));
}

/** Shared Account byline facts; neither a profile lookup nor an access decision. */
export function resolveAccountActorPresentation(actor: TranscriptAccountActor, viewerScope: ServerAccountScope | null) {
    const isSelf = areServerAccountScopesEqual(actor, viewerScope);
    // Explicit resource relationship wins even while the neutral profile remains
    // readable. Missing accessibility retains the pre-field/deleted-Account fallback.
    const classification = classifyAccountActorLabelV1(actor, isSelf);
    const isFormer = classification.kind === 'former';
    return {
        isSelf,
        name: localizeAccountActorLabel(classification),
        avatar: {
            id: isFormer ? 'former-member' : serverAccountScopeKeySuffix(actor),
            imageUrl: isFormer ? null : actor.profile?.avatarUrl,
        },
    };
}

/** Keep the same face while a Home-qualified Account's actor is loading. */
export function resolveAccountActorAvatar(
    scope: ServerAccountScope,
    actor: TranscriptAccountActor | null | undefined,
    viewerScope: ServerAccountScope | null,
) {
    return actor ? resolveAccountActorPresentation(actor, viewerScope).avatar
        : { id: serverAccountScopeKeySuffix(scope), imageUrl: null };
}

/** The transcript's byline visibility policy, shared by turn attribution surfaces. */
export function resolveVisibleAccountActorPresentation(input: Readonly<{
    actor: TranscriptAccountActor | null | undefined;
    viewerScope: ServerAccountScope | null;
    hasOtherNamedCollaborator: boolean;
}>) {
    if (!input.actor || !input.viewerScope) return null;
    const presentation = resolveAccountActorPresentation(input.actor, input.viewerScope);
    return presentation.isSelf && !input.hasOtherNamedCollaborator ? null : presentation;
}

import type { TranscriptAccountActor } from '@happier-dev/session-core/messages';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { formatAccountDisplayName } from './formatAccountDisplayName';
import { t } from '@/text';

/** The one generic label for an Account whose sanitized actor is unavailable. */
export function resolveUnknownAccountActorName(form: 'value' | 'sentence'): string {
    return form === 'sentence'
        ? t('session.collaboration.discussion.attribution.anotherPerson')
        : t('detailPages.approval.requester.anotherPerson');
}


/** Shared Account byline facts; neither a profile lookup nor an access decision. */
export function resolveAccountActorPresentation(actor: TranscriptAccountActor, viewerScope: ServerAccountScope | null) {
    const isSelf = areServerAccountScopesEqual(actor, viewerScope);
    return {
        isSelf,
        name: actor.profile === null
            ? t('message.accountActorFormerMember')
            : isSelf
                ? t('message.accountActorYou')
                : formatAccountDisplayName(actor.profile) ?? t('message.accountActorUnnamedMember'),
        avatar: {
            id: actor.profile === null ? 'former-member' : serverAccountScopeKeySuffix(actor),
            imageUrl: actor.profile?.avatarUrl,
        },
    };
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

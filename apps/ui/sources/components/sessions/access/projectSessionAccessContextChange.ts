import type {
    PrincipalRefV1} from '@happier-dev/protocol/teams/principal';
import type {
    SessionAccessLevelV1} from '@happier-dev/protocol/sessions/access/sessionAccessGrantV1';
import type {
    SessionTeamCredentialBindingConsequenceV1,
} from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import { t } from '@/text';

import { projectSessionAccessCredentialConsequences } from './projectSessionAccessEditorSnapshot';
import type { SessionAccessDirectoryTeamContext } from './useSessionAccessDirectory';

type CurrentGrant = Readonly<{
    subject: PrincipalRefV1;
    accessLevel: SessionAccessLevelV1;
}>;

/**
 * Presentation-only preview of server-projected Team policy facts.
 *
 * It intentionally does not classify Account recipients as internal/external,
 * decide whether the actor is a Team admin, or claim the mutation will succeed.
 * The canonical context mutation repeats those decisions in its transaction.
 */
export function projectSessionAccessContextChange(input: Readonly<{
    target: SessionAccessDirectoryTeamContext | null;
    current: SessionAccessDirectoryTeamContext | null;
    grants: readonly CurrentGrant[];
    /**
     * The Home's credential-consequence preview. Leaving a Team ends that Team's
     * context-required credential selections, which is a fact only the Home has.
     */
    credentialBindings?: readonly SessionTeamCredentialBindingConsequenceV1[];
    /** Locally opened names keyed by the exact resource binding id. */
    openedCredentialDisplayNames?: Readonly<Record<string, string | null>>;
}>): readonly string[] {
    const consequences: string[] = [];
    if (input.target?.sessionCreationPolicy === 'team_required') {
        const targetGrant = input.grants.find((grant) => grant.subject.kind === 'team'
            && grant.subject.teamId === input.target?.teamId);
        if (!targetGrant || targetGrant.accessLevel === 'view') {
            consequences.push(t('session.access.required'));
        }
    }

    const previousPolicy = input.current?.externalSharingPolicy ?? 'allowed';
    const nextPolicy = input.target?.externalSharingPolicy ?? 'allowed';
    const changesTeam = input.target?.teamId !== input.current?.teamId;
    // Moving between two Teams can reclassify the same current audience even
    // when both Teams publish the same restrictive policy. The editor does not
    // duplicate the server's membership/public-link classification, so it
    // reviews the target restriction whenever the Team changes.
    if (previousPolicy !== nextPolicy || (changesTeam && nextPolicy !== 'allowed')) {
        consequences.push(`${t('teams.settings.externalSharingSection')}: ${t(nextPolicy === 'disabled'
            ? 'teams.policy.externalSharingDisabled'
            : nextPolicy === 'team_admins_only'
                ? 'teams.policy.externalSharingAdmins'
                : 'teams.policy.externalSharingAllowed')}`);
    }

    if (changesTeam) {
        consequences.push(...projectSessionAccessCredentialConsequences(input.credentialBindings, {
            teamId: input.current?.teamId ?? null,
            policy: 'team_context_required',
        }, input.openedCredentialDisplayNames));
    }
    return consequences;
}

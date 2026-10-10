import type {
    AccountDisplayProfileV1,
    PrincipalRefV1,
    SessionAccessGrantsListResponseV1,
    SessionAccessPrincipalSummaryV1,
    SessionAccessSourceV1,
    SessionTeamCredentialBindingConsequenceV1,
} from '@happier-dev/protocol';
import { t } from '@/text';
import { presentSharePrincipal, sharePrincipalKey } from '@/components/sharing/sharePrincipalPresentation';
import { projectSessionAccessChipSummary } from './projectSessionAccessChipSummary';
import { projectSessionAccessLevelLabel } from './projectSessionAccessLevelLabel';
import type { SessionAccessDelegationControlModel, SessionAccessEditorModel, SessionAccessGrantOperationModel, SessionAccessLevel, SessionAccessPrincipalPresentation, SessionAccessGrantRowModel, SessionAccessUiReason } from './sessionAccessEditorTypes';
import { presentSessionAccessReason } from './presentSessionAccessFailure';

export const sessionAccessSubjectKey = sharePrincipalKey;

export function projectSessionAccessPrincipal(principal: SessionAccessPrincipalSummaryV1, viewer?: Readonly<{
    accountId?: string | null; profile?: AccountDisplayProfileV1 | null;
}>): SessionAccessPrincipalPresentation {
    const ref: PrincipalRefV1 = principal.kind === 'account' ? {kind:'account',accountId:principal.accountId}
        : principal.kind === 'team' ? {kind:'team',teamId:principal.teamId}
            : {kind:'group',teamId:principal.teamId,groupId:principal.groupId};
    return presentSharePrincipal({ ref, viewerAccountId: viewer?.accountId,
        ...(principal.kind === 'account' ? {
            profile: principal,
            viewerProfile: viewer?.profile,
            avatarUrl: principal.avatarUrl,
        } : { name: principal.name, ...(principal.kind === 'group' ? { teamName: principal.teamName } : {}) }) });
}

/**
 * The Home's credential-consequence preview for one Team, spoken as the
 * confirmation copy the editor already uses.
 *
 * It is the single consumer of that projection, so both places a manager can
 * take a Team's readability away — removing its grant and moving the Session's
 * context — name the same credentials. A Home that publishes no preview, and a
 * subject that is not a Team, both produce nothing.
 */
export function projectSessionAccessCredentialConsequences(
    consequences: readonly SessionTeamCredentialBindingConsequenceV1[] | undefined,
    scope: Readonly<{ teamId: string | null; policy: SessionTeamCredentialBindingConsequenceV1['policy'] }>,
): readonly string[] {
    if (!consequences || scope.teamId === null) return [];
    const names = consequences
        .filter((row) => row.teamId === scope.teamId && row.policy === scope.policy)
        .map((row) => row.displayName);
    return names.length === 0 ? [] : [t('session.access.credentialsLost', { names: names.join(', ') })];
}

/**
 * Effective-access sources have already been filtered by the server's canonical
 * access authority. Only their kind is safe/useful for an inspection-only UI;
 * grant ids and Team/Group ids remain authorization facts, never presentation.
 */
function accessSourceLabels(sources: readonly SessionAccessSourceV1[]): readonly string[] {
    const labels = new Set<string>();
    for (const source of sources) {
        switch (source.kind) {
            case 'owner': break;
            case 'direct': labels.add(t('session.access.sourceDirect')); break;
            case 'team':
                labels.add(t('session.access.sourceTeam'));
                if (source.requiredByTeamPolicy) labels.add(t('session.access.required'));
                break;
            case 'group': labels.add(t('session.access.sourceGroup')); break;
        }
    }
    return [...labels];
}

/**
 * The one runtime-permission-delegation control rule, shared by the live and
 * draft adapters.
 *
 * A View grant delegates nothing: the canonical grant mutation owner normalizes
 * its `canApprovePermissions` to false, so a row at View must offer no control
 * and state no value — a retained `true` from an earlier Edit/Admin level would
 * otherwise render as an enabled switch the server will never honor.
 */
export function projectSessionAccessDelegationControl(input: Readonly<{
    accessLevel: SessionAccessLevel;
    canApprovePermissions: boolean;
    /** Whether this actor may change delegation on this exact grant right now. */
    canChange: boolean;
    reason: SessionAccessUiReason;
}>): SessionAccessDelegationControlModel {
    if (input.accessLevel === 'view') return { kind: 'hidden' };
    return input.canChange
        ? { kind: 'editable', value: input.canApprovePermissions }
        : { kind: 'locked', value: input.canApprovePermissions, reason: input.reason };
}

export function projectSessionAccessEditorSnapshot(input: Readonly<{
    snapshot: SessionAccessGrantsListResponseV1;
    viewerAccountId?: string;
    viewerProfile?: AccountDisplayProfileV1 | null;
    operations?: Readonly<Record<string, SessionAccessGrantOperationModel>>;
    confirmingRemoval?: string | null;
}>): Pick<SessionAccessEditorModel, 'owner' | 'viewerAccess' | 'grants' | 'accessMode' | 'readOnlyReason' | 'summary'> {
    const { snapshot } = input;
    const editable = snapshot.effectiveAccess.capabilities.manageAccess;
    const denied = presentSessionAccessReason('session_access_forbidden');
    const viewerAccess = snapshot.effectiveAccess.level === 'owner' ? undefined : (() => {
        const levelLabel = projectSessionAccessLevelLabel(snapshot.effectiveAccess.level);
        const sourceLabels = accessSourceLabels(snapshot.effectiveAccess.sources);
        return {
            level: snapshot.effectiveAccess.level,
            levelLabel,
            sourceLabels,
            accessibilityLabel: t('session.access.accessibleSummary', {
                title: t('session.access.yourAccess'),
                label: [levelLabel, ...sourceLabels].join('. '),
            }),
        };
    })();
    const credentialConsequences = snapshot.visibility === 'complete'
        ? snapshot.credentialBindingConsequences
        : undefined;
    const grants: SessionAccessGrantRowModel[] = snapshot.grants.map((row) => {
        const key = sessionAccessSubjectKey(row.grant.subject);
        const transitions = row.allowedTransitions;
        const reason = transitions.reason ? presentSessionAccessReason(transitions.reason) : denied;
        return {
            grant: row.grant.subject,
            principal: projectSessionAccessPrincipal(row.principal, { accountId: input.viewerAccountId, profile: input.viewerProfile }),
            level: editable && transitions.accessLevels.length > 0
                ? {kind:'editable',value:row.grant.accessLevel,options:transitions.accessLevels}
                : {kind:'locked',value:row.grant.accessLevel,reason},
            permissionDelegation: projectSessionAccessDelegationControl({
                accessLevel: row.grant.accessLevel,
                canApprovePermissions: row.grant.canApprovePermissions,
                canChange: editable && transitions.canChangePermissionDelegation,
                reason,
            }),
            removal: editable && transitions.canRemove
                ? (input.confirmingRemoval === key
                    ? {kind:'confirming',consequences:projectSessionAccessCredentialConsequences(
                        credentialConsequences,
                        {
                            teamId: row.grant.subject.kind === 'team' ? row.grant.subject.teamId : null,
                            policy: 'team_visibility_required',
                        },
                    )}
                    : {kind:'allowed'})
                : {kind:'blocked',reason},
            requiredByTeamPolicy: row.grant.subject.kind === 'team' && 'requiredByTeamPolicy' in row.grant && row.grant.requiredByTeamPolicy,
            operation: input.operations?.[key] ?? {kind:'idle'},
        };
    });
    return {
        owner:{principal:projectSessionAccessPrincipal(snapshot.owner, { accountId: input.viewerAccountId, profile: input.viewerProfile })},grants,
        ...(viewerAccess ? { viewerAccess } : {}),
        accessMode:editable?'editable':'read_only',
        ...(!editable ? {readOnlyReason:{code:'session_access_read_only',message:t('session.access.readOnly')}} : {}),
        summary:projectSessionAccessChipSummary({grants,audienceComplete:snapshot.visibility==='complete'}),
    };
}

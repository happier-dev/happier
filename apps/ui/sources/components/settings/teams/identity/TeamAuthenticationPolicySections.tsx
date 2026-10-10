import * as React from 'react';
import type {
    TeamAcceptedAuthenticationV1,
    TeamAuthenticationPolicyV1,
} from '@happier-dev/protocol';
import {
    TeamErrorV1Schema,
    type TeamAdmissionModeApplicabilityV1,
    type TeamAdmissionModeV1,
    type TeamAuthenticationPolicyComparisonBasisV1,
    type TeamIdentityConnectionV1,
} from '@happier-dev/protocol/teams';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { setTeamPolicy } from '@/sync/ops/teams/teamOperations';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { t } from '@/text';

import type { TeamSectionContext } from '../teamSectionContext';
import { teamMutationFailureLabel } from '../teamMutationPresentation';
import { teamAdmissionModeLabel } from '../teamPolicyPresentation';
import { identityConnectionDiscriminator } from './identityAdministrationPresentation';
import { TEAM_AUTHENTICATION_SETTINGS } from './teamAuthenticationSettings';

const ADMISSION_MODES: readonly TeamAdmissionModeV1[] = Object.freeze([
    'invite_only',
    'provisioned',
    'jit',
]);

/** Each mode stays findable by search; all three land on the one row that chooses between them. */
const ADMISSION_SETTINGS = [
    TEAM_AUTHENTICATION_SETTINGS.settings.admissionInviteOnly,
    TEAM_AUTHENTICATION_SETTINGS.settings.admissionProvisioned,
    TEAM_AUTHENTICATION_SETTINGS.settings.admissionJit,
];

const ACCEPTED_MODE_SETTINGS = [
    TEAM_AUTHENTICATION_SETTINGS.settings.acceptedInherit,
    TEAM_AUTHENTICATION_SETTINGS.settings.acceptedRestricted,
];

type UnavailableAdmissionMode = Extract<
    TeamAdmissionModeApplicabilityV1['modes'][TeamAdmissionModeV1],
    { status: 'unavailable' }
>;

/**
 * The Home's own reason, in copy written for that exact reason.
 *
 * Each branch owns one localized sentence rather than assembling neighbouring
 * section copy with hardcoded punctuation: the sentence order, spacing and
 * wording belong to the locale, and an administrator reading "a Home
 * administrator does not allow this" must not be told the same thing as one
 * whose Home simply has not published that provider yet. The reason is the key,
 * so the same explanation appears wherever a mode carries it.
 */
function admissionModeUnavailableLabel(availability: UnavailableAdmissionMode): string {
    switch (availability.reason) {
        case 'home_policy_unavailable':
            return t('teams.authentication.policy.admissionUnavailableReason.homePolicyUnavailable');
        case 'home_policy_prohibited':
            return t('teams.authentication.policy.admissionUnavailableReason.homePolicyProhibited');
        case 'directory_source_required':
            return t('teams.authentication.policy.admissionUnavailableReason.directorySourceRequired');
        case 'directory_projection_required':
            return t('teams.authentication.policy.admissionUnavailableReason.directoryProjectionRequired');
        case 'team_connection_required':
            return t('teams.authentication.policy.admissionUnavailableReason.teamConnectionRequired');
        case 'team_connection_unavailable':
            return t('teams.authentication.policy.admissionUnavailableReason.teamConnectionUnavailable');
    }
}

/** `unset`: the stored restriction cannot be read, so neither choice is the current one. */
type AcceptedChoice = 'inherit' | 'restricted' | 'unset';

function acceptedKey(reference: TeamAcceptedAuthenticationV1): string {
    return reference.kind === 'home_method'
        ? `home_method:${reference.methodId.toLowerCase()}`
        : `team_connection:${reference.connectionId}`;
}

/**
 * The Home's refusal, said in the words that describe what actually happened.
 *
 * `team_authentication_policy_unavailable` is the Home reporting that it cannot
 * currently enforce the requested policy — for example because accepted
 * sign-in has not been proven against the live provider, or because admission
 * evidence changed after the list projection was read. It is never
 * reinterpreted here as a client-side ceiling: the Home's own answer is what
 * the administrator reads.
 */
function policyFailureLabel(failure: Readonly<{ code: string | null; details?: unknown }>): string | null {
    if (failure.code === 'team_authentication_policy_unavailable') {
        const domainError = TeamErrorV1Schema.safeParse(failure.details);
        return domainError.success
            && domainError.data.error === failure.code
            && domainError.data.details?.reason === 'provider_test_required'
            ? t('teams.authentication.policy.providerTestRequired')
            : t('teams.authentication.policy.unavailable');
    }
    return null;
}

/**
 * Admission and accepted sign-in for one exact Team, written through the single
 * revision-guarded `teams.policy.set` owner.
 *
 * Accepted sign-in is compare-and-set: the Home requires the canonical value the
 * editor actually read, so a policy that moved underneath is refused rather than
 * silently overwritten. The basis is captured when the draft begins and is only
 * advanced by an explicit acknowledgement of the newly observed policy, so the
 * administrator's intent survives the conflict instead of being discarded.
 *
 * Both arms of the OR are authored here: this Team's own connections and the
 * Home sign-in methods the Home already advertises publicly. The Home methods
 * arrive from the one canonical auth-entry projection its own sign-in page uses,
 * so nothing about Home configuration is disclosed that a visitor could not
 * already see and no second Home-method owner exists. A stored `home_method`
 * the Home no longer offers is still shown and preserved rather than silently
 * dropped, but it cannot be re-added once it is gone.
 */
export const TeamAuthenticationPolicySections = React.memo(function TeamAuthenticationPolicySections(
    props: Readonly<{
        context: TeamSectionContext;
        connections: readonly TeamIdentityConnectionV1[];
        /** False while the connection projection is absent, refreshing or stale. */
        connectionsCurrent: boolean;
        admissionModeApplicability: TeamAdmissionModeApplicabilityV1 | null;
        /** Home sign-in methods that can currently log somebody in, as the Home advertises them. */
        homeMethods: readonly Readonly<{ methodId: string; displayName: string }>[];
        /** False while the Home auth-entry projection has not answered. */
        homeMethodsCurrent: boolean;
    }>,
) {
    const {
        context,
        connections,
        connectionsCurrent,
        admissionModeApplicability,
        homeMethods,
        homeMethodsCurrent,
    } = props;
    const policy = context.team.policy;
    const repairRequired = policy.authenticationPolicyStatus === 'repair_required';

    // The exact value the Home says it holds right now, in the shape its
    // compare-and-set input expects. Unreadable persisted policy has its own
    // basis: it is not inheritance and must not be compared as null.
    const observedBasis: TeamAuthenticationPolicyComparisonBasisV1 = repairRequired
        ? { v: 1, status: 'repair_required' }
        : policy.authenticationPolicy;
    const observedBasisKey = JSON.stringify(observedBasis);

    const [draft, setDraft] = React.useState<TeamAuthenticationPolicyV1 | null>(null);
    const [basisKey, setBasisKey] = React.useState<string | null>(null);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [admissionPending, setAdmissionPending] = React.useState<TeamAdmissionModeV1 | null>(null);
    const [admissionNotice, setAdmissionNotice] = React.useState<string | null>(null);
    // The shell owns the shared-approval artifact and releases it on execution,
    // rejection and failure, so this is the only truthful source of "still
    // waiting". Latching it here would survive a terminal decision.
    const approvalPending = context.approvalPending;
    // Closes the duplicate-submit window that opens between the press and the
    // render that would disable the control; no debounce is involved.
    const operationInFlightRef = React.useRef<symbol | null>(null);
    // `null` is a valid compare-and-set basis (Home inheritance), so absence
    // needs its own sentinel.
    const basisRef = React.useRef<TeamAuthenticationPolicyComparisonBasisV1 | undefined>(undefined);

    React.useEffect(() => () => {
        operationInFlightRef.current = null;
    }, []);

    // Once the Home publishes what the administrator asked for, the draft has
    // served its purpose and the projection becomes the only truth again.
    const draftKey = draft === null ? null : JSON.stringify(draft);
    React.useEffect(() => {
        if (draftKey === null) return;
        const committedKey = repairRequired
            ? null
            : JSON.stringify(policy.authenticationPolicy ?? { v: 1, mode: 'inherit' });
        if (committedKey !== draftKey) return;
        setDraft(null);
        setBasisKey(null);
        basisRef.current = undefined;
        setError(null);
    }, [draftKey, policy.authenticationPolicy, repairRequired]);

    const committedMode: 'inherit' | 'restricted' | null = repairRequired
        ? null
        : policy.authenticationPolicy === null ? 'inherit' : 'restricted';
    const selected: TeamAuthenticationPolicyV1 | null = draft
        ?? (repairRequired
            ? null
            : policy.authenticationPolicy ?? { v: 1, mode: 'inherit' });
    const selectedMode = selected?.mode ?? null;
    const accepted: readonly TeamAcceptedAuthenticationV1[] = selected?.mode === 'restricted'
        ? selected.accepted
        : [];
    const acceptedKeys = new Set(accepted.map(acceptedKey));
    const offeredHomeMethodKeys = new Set(homeMethods.map((method) => `home_method:${method.methodId.toLowerCase()}`));
    // References the stored policy carries that the Home no longer advertises.
    // They are displayed and preserved rather than silently dropped, but a
    // method the Home does not offer cannot be re-added once removed.
    const retainedHomeMethods = accepted.filter(
        (reference): reference is Extract<TeamAcceptedAuthenticationV1, { kind: 'home_method' }> =>
            reference.kind === 'home_method' && !offeredHomeMethodKeys.has(acceptedKey(reference)),
    );

    const editable = context.team.capabilities.manageAuthentication
        && context.canMutate
        && !saving
        && admissionPending === null;
    const admissionEditable = editable
        && connectionsCurrent
        && admissionModeApplicability !== null;
    const conflicted = basisKey !== null && basisKey !== observedBasisKey;

    const beginDraft = React.useCallback((next: TeamAuthenticationPolicyV1) => {
        if (basisRef.current === undefined) {
            basisRef.current = observedBasis;
            setBasisKey(observedBasisKey);
        }
        setDraft(next);
        setError(null);
    }, [observedBasis, observedBasisKey]);

    // Abandoning the edit is a local decision only: the Home is never told, and
    // the authoritative projection becomes the whole truth again.
    const cancelDraft = React.useCallback(() => {
        basisRef.current = undefined;
        setBasisKey(null);
        setDraft(null);
        setError(null);
    }, []);

    const acknowledgeCurrentBasis = React.useCallback(() => {
        basisRef.current = observedBasis;
        setBasisKey(observedBasisKey);
        setError(null);
    }, [observedBasis, observedBasisKey]);

    const chooseMode = React.useCallback((mode: 'inherit' | 'restricted') => {
        if (mode === 'inherit') { beginDraft({ v: 1, mode: 'inherit' }); return; }
        beginDraft({
            v: 1,
            mode: 'restricted',
            accepted: accepted.length > 0
                ? [...accepted]
                : connections
                    .filter((connection) => connection.enabled)
                    .map((connection) => ({ kind: 'team_connection' as const, connectionId: connection.id })),
        });
    }, [accepted, beginDraft, connections]);

    // One toggle for both arms of the OR: the reference the caller names is the
    // only difference, so the add/remove rule cannot drift between them.
    const toggleAccepted = React.useCallback((reference: TeamAcceptedAuthenticationV1) => {
        const key = acceptedKey(reference);
        const next = acceptedKeys.has(key)
            ? accepted.filter((existing) => acceptedKey(existing) !== key)
            : [...accepted, reference];
        beginDraft({ v: 1, mode: 'restricted', accepted: next });
    }, [accepted, acceptedKeys, beginDraft]);

    const submitPolicy = React.useCallback(async () => {
        const basis = basisRef.current;
        if (operationInFlightRef.current !== null || draft === null || basis === undefined) return;
        if (draft.mode === 'restricted' && draft.accepted.length === 0) return;
        const operationIdentity = Symbol('team-authentication-policy');
        operationInFlightRef.current = operationIdentity;
        setSaving(true);
        setError(null);
        try {
            const outcome = await setTeamPolicy({
                scope: context.scope,
                address: context.address,
                previousAuthenticationPolicy: basis,
                authenticationPolicy: draft,
            });
            if (operationInFlightRef.current !== operationIdentity) return;
            if (outcome.kind === 'succeeded') return;
            if (outcome.failure.code === 'team_authentication_policy_conflict') {
                // The Home moved under the edit. Keep the intent, re-read, and
                // require one deliberate acknowledgement of the new basis.
                setBasisKey(null);
                basisRef.current = undefined;
                setError(t('teams.authentication.policy.conflictBody'));
                context.refresh();
                return;
            }
            setError(policyFailureLabel(outcome.failure) ?? teamMutationFailureLabel(outcome.failure));
        } catch (cause) {
            if (isTeamActionApprovalPendingError(cause)) {
                // The shell now renders and owns the pending state.
                context.requestApproval(cause.artifactId);
                return;
            }
            setError(t('teams.errors.generic'));
        } finally {
            if (operationInFlightRef.current === operationIdentity) {
                operationInFlightRef.current = null;
                setSaving(false);
            }
        }
    }, [context, draft]);

    const chooseAdmission = React.useCallback(async (mode: TeamAdmissionModeV1) => {
        if (
            operationInFlightRef.current !== null
            || mode === policy.admissionMode
            || !admissionEditable
            || admissionModeApplicability?.modes[mode].status !== 'available'
        ) return;
        const operationIdentity = Symbol('team-admission-mode');
        operationInFlightRef.current = operationIdentity;
        setAdmissionPending(mode);
        setAdmissionNotice(null);
        try {
            const outcome = await setTeamPolicy({
                scope: context.scope,
                address: context.address,
                admissionMode: mode,
            });
            if (operationInFlightRef.current !== operationIdentity) return;
            if (outcome.kind === 'succeeded') return;
            // The Home refused. The selection below still shows the mode the
            // Home holds, so nothing claims a change that did not happen.
            setAdmissionNotice(
                outcome.failure.code === 'team_authentication_policy_unavailable'
                    ? t('teams.authentication.policy.admissionUnavailable')
                    : teamMutationFailureLabel(outcome.failure),
            );
        } catch (cause) {
            if (isTeamActionApprovalPendingError(cause)) {
                // No local notice: the shared approval is the shell's fact, and
                // a rejection there must not leave this section saying "waiting".
                context.requestApproval(cause.artifactId);
                return;
            }
            setAdmissionNotice(t('teams.errors.generic'));
        } finally {
            if (operationInFlightRef.current === operationIdentity) {
                operationInFlightRef.current = null;
                setAdmissionPending(null);
            }
        }
    }, [admissionEditable, admissionModeApplicability, context, policy.admissionMode]);

    const restrictedWithoutReferences = selectedMode === 'restricted' && accepted.length === 0;
    const canApply = editable
        && draft !== null
        && !conflicted
        && basisKey !== null
        && !restrictedWithoutReferences;

    const conflictLine = (testID: string) => (
        <SurfaceStateCard
            testID={testID}
            kind="warning"
            size="line"
            title={t('teams.errors.conflict')}
            reason={t('teams.authentication.policy.conflictBody')}
            action={{ label: t('common.continue'), onPress: acknowledgeCurrentBasis, disabled: saving, testID: `${testID}:continue` }}
            accessibilitySemantics="alert"
        />
    );

    return (
        <>
            {/* Who can join (lab `tsAuth-A`): one decision, so one row with every mode in view. A
                mode the Home cannot enforce stays visible, unavailable, with the Home's own reason
                under the label. A choice applies as soon as it is made. */}
            <SettingSection section={TEAM_AUTHENTICATION_SETTINGS.sectionRefs.admission}><ItemGroup
                title={t('teams.authentication.policy.admissionSection')}
                description={t('teams.authentication.policy.admissionHelp')}
            >
                <SettingAnchor settings={ADMISSION_SETTINGS}>
                    <SegmentedChoiceItem<TeamAdmissionModeV1>
                        testID="team-admission-mode"
                        title={t('teams.authentication.policy.admissionRow')}
                        subtitleLines={0}
                        accessoryLayout="stacked"
                        options={ADMISSION_MODES.map((mode) => {
                            const availability = admissionModeApplicability?.modes[mode] ?? null;
                            return {
                                id: mode,
                                label: teamAdmissionModeLabel(mode),
                                // The mode the Home holds stays shown chosen even when it can no
                                // longer be enforced, and says why like any other unavailable mode.
                                unavailableReason: availability?.status === 'unavailable'
                                    ? admissionModeUnavailableLabel(availability)
                                    : undefined,
                            };
                        })}
                        value={admissionPending ?? policy.admissionMode}
                        onChange={(mode) => { void chooseAdmission(mode); }}
                        disabled={!admissionEditable}
                        loading={admissionPending !== null}
                        testIDPrefix="team-admission-mode"
                    />
                </SettingAnchor>
                {admissionNotice ? (
                    <SurfaceStateCard
                        testID="team-admission-notice"
                        kind="error"
                        size="line"
                        title={admissionNotice}
                        accessibilitySemantics="alert"
                    />
                ) : approvalPending ? (
                    <SurfaceStateCard
                        testID="team-admission-approval-pending"
                        kind="warning"
                        size="line"
                        title={t('teams.authentication.policy.approvalPending')}
                        accessibilitySemantics="status"
                    />
                ) : null}
            </ItemGroup></SettingSection>

            {/* How members sign in: the choice between the Home's sign-in and the Team's own set,
                and, for "only these", the set itself as checkboxes directly beneath it. The edit is
                one draft, saved or discarded with the row of buttons that closes the section. */}
            <SettingSection section={TEAM_AUTHENTICATION_SETTINGS.sectionRefs.accepted}><ItemGroup
                title={t('teams.authentication.policy.acceptedSection')}
                description={t('teams.authentication.policy.acceptedHelp')}
            >
                {repairRequired && committedMode === null ? (
                    <SurfaceStateCard
                        testID="team-authentication-policy-repair"
                        kind="warning"
                        size="line"
                        title={t('teams.authentication.policy.repairRequired')}
                        reason={t('teams.authentication.policy.repairRequiredHelp')}
                        accessibilitySemantics="alert"
                    />
                ) : null}
                <SettingAnchor settings={ACCEPTED_MODE_SETTINGS}>
                    <SegmentedChoiceItem<AcceptedChoice>
                        testID="team-authentication-policy-mode"
                        title={t('teams.authentication.policy.acceptedRow')}
                        subtitle={restrictedWithoutReferences ? t('teams.authentication.policy.connectionsEmpty') : undefined}
                        subtitleLines={0}
                        accessoryLayout="stacked"
                        options={[
                            { id: 'inherit', label: t('teams.authentication.policy.acceptedInherit') },
                            // The set to choose from is the connection list: it must be current.
                            { id: 'restricted', label: t('teams.authentication.policy.acceptedRestricted'), disabled: !connectionsCurrent },
                        ]}
                        value={selectedMode ?? 'unset'}
                        onChange={(mode) => { if (mode !== 'unset' && mode !== selectedMode) chooseMode(mode); }}
                        disabled={!editable}
                        testIDPrefix="team-authentication-policy-mode"
                    />
                </SettingAnchor>
                {selectedMode === 'restricted' ? (
                    <SettingAnchor setting={TEAM_AUTHENTICATION_SETTINGS.settings.acceptedMethods}><>
                    {connections.map((connection) => {
                        const checked = acceptedKeys.has(`team_connection:${connection.id}`);
                        // Two connections may share a provider name. Naming only
                        // the provider would ask for a blind choice, so the exact
                        // connection is spelled out whenever it is ambiguous.
                        const ambiguous = connections.some((other) => other.id !== connection.id
                            && other.provider.displayName === connection.provider.displayName);
                        const owner = t('teams.authentication.policy.connectionOwnerTeam');
                        return (
                            <Item
                                key={connection.id}
                                testID={`team-authentication-policy-connection:${connection.id}`}
                                title={connection.provider.displayName}
                                subtitle={ambiguous
                                    ? `${owner} · ${identityConnectionDiscriminator(connection)}`
                                    : owner}
                                accessibilityLabel={ambiguous
                                    ? `${connection.provider.displayName}, ${owner}, ${identityConnectionDiscriminator(connection)}`
                                    : `${connection.provider.displayName}, ${owner}`}
                                accessibilityRole="checkbox"
                                webRole="checkbox"
                                selected={checked}
                                accessibilityChecked={checked}
                                disabled={!editable || (!connection.enabled && !checked)}
                                onPress={editable && (connection.enabled || checked)
                                    ? () => toggleAccepted({ kind: 'team_connection', connectionId: connection.id })
                                    : undefined}
                                showChevron={false}
                            />
                        );
                    })}
                    {homeMethods.map((method) => {
                        const checked = acceptedKeys.has(`home_method:${method.methodId.toLowerCase()}`);
                        const owner = t('teams.authentication.policy.connectionOwnerHome');
                        return (
                            <Item
                                key={`home_method:${method.methodId.toLowerCase()}`}
                                testID={`team-authentication-policy-home-method:${method.methodId}`}
                                title={method.displayName}
                                subtitle={owner}
                                accessibilityLabel={`${method.displayName}, ${owner}`}
                                accessibilityRole="checkbox"
                                webRole="checkbox"
                                selected={checked}
                                accessibilityChecked={checked}
                                disabled={!editable || !homeMethodsCurrent}
                                onPress={editable && homeMethodsCurrent
                                    ? () => toggleAccepted({ kind: 'home_method', methodId: method.methodId })
                                    : undefined}
                                showChevron={false}
                            />
                        );
                    })}
                    {retainedHomeMethods.map((reference) => (
                        // A retained reference is preserved, not frozen: the Home
                        // stopped offering this method, and a restricted policy
                        // that still accepts it is refused on save, so the one
                        // recovery is to deselect it here. It stays a real
                        // selection — removing it drops it from the draft, and
                        // because the Home no longer offers it, it cannot come
                        // back — rather than an inert row whose only escape is
                        // abandoning the whole policy for inheritance. The Home no
                        // longer publishes a name for it, so the row is titled by
                        // what it is and the stored id stays a quiet mono detail.
                        <Item
                            key={acceptedKey(reference)}
                            testID={`team-authentication-policy-home-method:${reference.methodId}`}
                            title={t('teams.authentication.policy.connectionOwnerHome')}
                            subtitle={t('teams.authentication.policy.homeMethodRetained')}
                            detail={reference.methodId}
                            accessibilityLabel={`${t('teams.authentication.policy.connectionOwnerHome')}, ${reference.methodId}, ${t('teams.authentication.policy.homeMethodRetained')}`}
                            accessibilityRole="checkbox"
                            webRole="checkbox"
                            selected
                            accessibilityChecked
                            disabled={!editable}
                            onPress={editable
                                ? () => toggleAccepted({ kind: 'home_method', methodId: reference.methodId })
                                : undefined}
                            showChevron={false}
                        />
                    ))}
                    {connections.length === 0 && homeMethods.length === 0 ? (
                        <SurfaceStateCard
                            testID="team-authentication-policy-connections-empty"
                            kind="empty"
                            size="line"
                            title={t('teams.authentication.policy.connectionsEmpty')}
                        />
                    ) : null}
                    </></SettingAnchor>
                ) : null}
                {draft !== null && conflicted ? conflictLine('team-authentication-policy-conflict') : null}
                {draft !== null && basisKey === null ? conflictLine('team-authentication-policy-rebase') : null}
                {draft !== null && approvalPending ? (
                    <SurfaceStateCard
                        testID="team-authentication-policy-approval-pending"
                        kind="warning"
                        size="line"
                        title={t('teams.authentication.policy.approvalPending')}
                        accessibilitySemantics="status"
                    />
                ) : null}
            </ItemGroup></SettingSection>

            {draft !== null ? (
                <ItemGroup surface="none">
                    <SectionButtonRow
                        footnote={error}
                        footnoteTone="danger"
                        footnoteTestID="team-authentication-policy-error"
                    >
                        <SettingAnchor setting={TEAM_AUTHENTICATION_SETTINGS.settings.save}><RoundButton
                            testID="team-authentication-policy-save"
                            size="small"
                            title={t('common.save')}
                            loading={saving}
                            disabled={!canApply}
                            onPress={() => { void submitPolicy(); }}
                        /></SettingAnchor>
                        <RoundButton
                            testID="team-authentication-policy-cancel"
                            size="small"
                            display="inverted"
                            title={t('common.cancel')}
                            disabled={saving}
                            onPress={cancelDraft}
                        />
                    </SectionButtonRow>
                </ItemGroup>
            ) : null}
        </>
    );
});

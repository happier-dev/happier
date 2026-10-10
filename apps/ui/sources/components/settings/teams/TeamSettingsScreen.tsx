import * as React from 'react';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
    TEAM_NAME_MAX_LENGTH_V1,
    validateTeamDescriptionV1,
    validateTeamNameV1,
    type TeamAdmissionModeV1,
    type TeamExternalSharingPolicyV1,
    type TeamSessionCreationPolicyV1,
    type SessionHistoryAccessV1,
} from '@happier-dev/protocol/teams';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon } from '@/components/ui/icons/Icon';
import { Modal } from '@/modal';
import {
    archiveTeam,
    removeTeamLogo,
    restoreTeam,
    setTeamLogo,
    setTeamPolicy,
    updateTeam,
} from '@/sync/ops/teams/teamOperations';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { t } from '@/text';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';

import { useTeamManagerNames } from '@/hooks/teams/useTeamManagerNames';

import { askTeamManagersText } from './collection/teamsCreateGuidanceText';
import { teamArchiveConfirmationLines } from './teamLifecyclePresentation';
import { TeamSection } from './TeamSection';
import { TeamLogoPicker } from './TeamLogoPicker';
import type { TeamSectionContext } from './teamSectionContext';
import { teamMutationFailureLabel } from './teamMutationPresentation';
import { useEditedMetadataDraft } from './useEditedMetadataDraft';
import {
    externalSharingConsequence,
    externalSharingLabel,
    historyConsequence,
    historyLabel,
    sessionCreationConsequence,
    sessionCreationLabel,
    type TeamPolicyField,
} from './teamPolicyPresentation';

/** The size of the Team mark on a read-only logo row. */
const READ_ONLY_LOGO_SIZE = 32;

const SESSION_CREATION_OPTIONS: readonly TeamSessionCreationPolicyV1[] = Object.freeze([
    'private_default',
    'team_default',
    'team_required',
]);

const EXTERNAL_SHARING_OPTIONS: readonly TeamExternalSharingPolicyV1[] = Object.freeze([
    'allowed',
    'team_admins_only',
    'disabled',
]);

const HISTORY_OPTIONS: readonly SessionHistoryAccessV1[] = Object.freeze([
    'from_membership',
    'all_existing',
]);

const TeamIdentitySection = React.memo(function TeamIdentitySection(props: Readonly<{
    context: TeamSectionContext;
}>) {
    const { context } = props;
    const navigation = useNavigation();
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [saved, setSaved] = React.useState(false);
    const nameInputRef = React.useRef<React.ComponentRef<typeof FieldTextInput> | null>(null);
    const saveInFlightRef = React.useRef(false);

    React.useEffect(() => () => {
        saveInFlightRef.current = false;
    }, []);

    // The Home's answer stays authoritative while an unfinished draft survives a
    // refresh: the shared editor owner holds that decision for both this section
    // and the Group metadata section.
    const publishedName = context.team.name;
    const publishedDescription = context.team.description ?? '';
    const draft = useEditedMetadataDraft({ name: publishedName, description: publishedDescription });
    const { name, description, conflict } = draft;
    useUnsavedDraftNavigationGuard({
        navigation,
        isDirty: draft.isDirty,
        onDiscard: draft.reset,
        tag: 'TeamSettingsScreen.beforeRemove',
    });

    const nameValidation = validateTeamNameV1(name);
    const descriptionValidation = validateTeamDescriptionV1(description);
    const changed = nameValidation.status === 'ok'
        && descriptionValidation.status === 'ok'
        && (nameValidation.name !== publishedName
            || (descriptionValidation.description ?? '') !== publishedDescription);

    const save = React.useCallback(async () => {
        if (saveInFlightRef.current) return;
        if (nameValidation.status !== 'ok' || descriptionValidation.status !== 'ok') {
            if (nameValidation.status !== 'ok') nameInputRef.current?.focus();
            return;
        }
        saveInFlightRef.current = true;
        setSaving(true);
        setError(null);
        try {
            const outcome = await updateTeam({
                scope: context.scope,
                address: context.address,
                name: nameValidation.name,
                description: descriptionValidation.description,
            });
            if (outcome.kind === 'succeeded') {
                draft.commit({
                    name: outcome.team.name,
                    description: outcome.team.description ?? '',
                });
                setSaved(true);
                return;
            }
            setError(teamMutationFailureLabel(outcome.failure));
        } catch (cause) {
            if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.artifactId);
            else setError(t('teams.errors.generic'));
        } finally {
            saveInFlightRef.current = false;
            setSaving(false);
        }
    }, [context, draft, nameValidation, descriptionValidation]);

    const acceptCurrentBasis = React.useCallback(() => {
        draft.acceptPublished();
        setSaved(false);
    }, [draft]);

    const cancel = React.useCallback(() => {
        draft.reset();
        setError(null);
        setSaved(false);
    }, [draft]);

    const editable = context.team.capabilities.manageSettings && !context.archived;
    const draftOpen = draft.isDirty || conflict;
    return (
        <>
            {/* Somebody else changed the Team while this draft was open: the Home's answer is
                shown, and continuing adopts it as the basis the draft is compared against. */}
            {conflict ? (
                <AttentionBanner
                    testID="team-settings-identity-conflict-notice"
                    title={t('teams.errors.conflict')}
                    description={[publishedName, publishedDescription].filter(Boolean).join('\n')}
                    accessibilityLiveRegion="assertive"
                    action={{
                        label: t('common.continue'),
                        onPress: acceptCurrentBasis,
                        disabled: saving,
                        testID: 'team-settings-identity-conflict',
                    }}
                />
            ) : null}
            {/* One save model (DR-18, lab `tsSettings-E`): the Team's name, description and logo are a
                draft with Cancel and Save together in the section action, shown only while there is
                something to save or discard. Sharing choices below apply the moment they are chosen. */}
            <ItemGroup title={t('teams.create.detailsSection')} action={draftOpen ? (
                <SectionButtonRow>
                    <RoundButton
                        testID="team-settings-cancel"
                        size="small"
                        display="inverted"
                        title={t('common.cancel')}
                        disabled={saving}
                        onPress={cancel}
                    />
                    <RoundButton
                        testID="team-settings-save"
                        size="small"
                        title={t('common.save')}
                        loading={saving}
                        disabled={!changed || conflict || saving || !context.canMutate}
                        onPress={() => void save()}
                    />
                </SectionButtonRow>
            ) : undefined}>
                <Item
                    title={t('teams.create.nameLabel')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            ref={nameInputRef}
                            testID="team-settings-name"
                            value={name}
                            onChangeText={(next) => { draft.setName(next); setSaved(false); }}
                            placeholder={t('teams.create.namePlaceholder')}
                            accessibilityLabel={t('teams.create.nameLabel')}
                            maxLength={TEAM_NAME_MAX_LENGTH_V1}
                            editable={editable}
                            error={nameValidation.status !== 'ok' ? t('teams.errors.invalidName') : null}
                        />
                    )}
                />
                <Item
                    title={t('teams.create.descriptionLabel')}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        // Same contract as the Group forms: the canonical validator
                        // decides, and an overlong description says so instead of
                        // leaving a disabled Save with no explanation.
                        <FieldTextInput
                            testID="team-settings-description"
                            value={description}
                            onChangeText={(next) => { draft.setDescription(next); setSaved(false); }}
                            placeholder={t('teams.create.descriptionPlaceholder')}
                            accessibilityLabel={t('teams.create.descriptionLabel')}
                            multiline
                            minLines={2}
                            editable={editable}
                            error={descriptionValidation.status !== 'ok' ? t('teams.errors.invalidDescription') : null}
                        />
                    )}
                />
                <TeamLogoSection context={context} />
            </ItemGroup>
            {error || (saved && !changed) ? <ItemGroup surface="none">
                    <SectionButtonRow
                        footnote={error ?? t('teams.settings.saved')}
                        footnoteTone={error ? 'danger' : 'secondary'}
                        footnoteTestID={error ? 'team-settings-identity-error' : 'team-settings-saved'}
                    >
                        {null}
                    </SectionButtonRow>
            </ItemGroup> : null}
        </>
    );
});

/** The Team's name, description and logo as facts, for a viewer who cannot change them. */
const TeamIdentityFacts = React.memo(function TeamIdentityFacts(props: Readonly<{
    context: TeamSectionContext;
}>) {
    const { team, address } = props.context;
    return (
        <ItemGroup title={t('teams.create.detailsSection')}>
            <Item
                testID="team-settings-name-fact"
                title={t('teams.create.nameLabel')}
                detail={team.name}
                showChevron={false}
            />
            {team.description ? (
                <Item
                    testID="team-settings-description-fact"
                    title={t('teams.create.descriptionLabel')}
                    detail={team.description}
                    showChevron={false}
                />
            ) : null}
            <Item
                testID="team-settings-logo-fact"
                title={t('teams.settings.logoSection')}
                showChevron={false}
                rightElement={(
                    <Avatar
                        id={address.teamId}
                        square
                        size={READ_ONLY_LOGO_SIZE}
                        imageUrl={team.logo?.url ?? null}
                        thumbhash={team.logo?.thumbhash ?? null}
                    />
                )}
            />
        </ItemGroup>
    );
});

const TeamLogoSection = React.memo(function TeamLogoSection(props: Readonly<{
    context: TeamSectionContext;
}>) {
    const { context } = props;
    const [error, setError] = React.useState<string | null>(null);
    const [removing, setRemoving] = React.useState(false);
    const removeInFlightRef = React.useRef(false);

    React.useEffect(() => () => {
        removeInFlightRef.current = false;
    }, []);

    const use = React.useCallback<React.ComponentProps<typeof TeamLogoPicker>['onUse']>(async (image, onSettled) => {
        try {
            const outcome = await setTeamLogo({
                scope: context.scope,
                address: context.address,
                image,
                onApprovalSucceeded: () => onSettled({ kind: 'succeeded' }),
                onApprovalFailed: (code) => onSettled({
                    kind: 'failed',
                    message: code === 'approval_rejected' ? t('teams.errors.forbidden') : t('teams.logo.failed'),
                }),
            });
            return outcome.kind === 'succeeded'
                ? { kind: 'succeeded' as const }
                : { kind: 'failed' as const, message: teamMutationFailureLabel(outcome.failure) };
        } catch (cause) {
            if (isTeamActionApprovalPendingError(cause)) {
                context.requestApproval(cause.registration);
                return { kind: 'pending' as const };
            }
            return { kind: 'failed' as const, message: t('teams.logo.failed') };
        }
    }, [context]);

    const remove = React.useCallback(async () => {
        if (removeInFlightRef.current) return;
        removeInFlightRef.current = true;
        const confirmed = await Modal.confirm(
            t('teams.logo.removeConfirmTitle'),
            t('teams.logo.removeConfirmBody'),
            { confirmText: t('teams.logo.remove'), destructive: true },
        );
        if (!confirmed) {
            removeInFlightRef.current = false;
            return;
        }
        setRemoving(true);
        setError(null);
        try {
            const outcome = await removeTeamLogo({
                scope: context.scope,
                address: context.address,
            });
            if (outcome.kind === 'failed') setError(teamMutationFailureLabel(outcome.failure));
        } catch (cause) {
            if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.artifactId);
            else setError(t('teams.logo.failed'));
        } finally {
            removeInFlightRef.current = false;
            setRemoving(false);
        }
    }, [context]);

    return (
        <TeamLogoPicker
            identityId={context.address.teamId}
            testIDPrefix="team-settings"
            currentLogo={context.team.logo}
            disabled={!context.team.capabilities.manageSettings || !context.canMutate || removing}
            onUse={use}
            remove={{
                onPress: () => void remove(),
                busy: removing,
                disabled: !context.canMutate || removing,
                error,
            }}
        />
    );
});

const TeamPolicySections = React.memo(function TeamPolicySections(props: Readonly<{
    context: TeamSectionContext;
}>) {
    const { context } = props;
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const operationInFlightRef = React.useRef(false);
    const { policy } = context.team;

    React.useEffect(() => () => {
        operationInFlightRef.current = false;
    }, []);

    const canEdit = context.team.capabilities.managePolicy && context.canMutate && !busy;
    // Nobody changes an archived Team, and a viewer without the capability never could.
    const readOnly = !context.team.capabilities.managePolicy || context.archived;
    const teamName = context.team.name;

    const patch = React.useCallback(async (
        next: Parameters<typeof setTeamPolicy>[0] extends infer P
            ? Omit<Extract<P, object>, 'scope' | 'address'>
            : never,
    ) => {
        if (operationInFlightRef.current) return;
        operationInFlightRef.current = true;
        setBusy(true);
        setError(null);
        let outcome: Awaited<ReturnType<typeof setTeamPolicy>>;
        try {
            outcome = await setTeamPolicy({ scope: context.scope, address: context.address, ...next });
        } catch (cause) {
            if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.artifactId);
            else setError(t('teams.errors.generic'));
            operationInFlightRef.current = false;
            setBusy(false);
            return;
        }
        operationInFlightRef.current = false;
        setBusy(false);
        if (outcome.kind === 'failed') setError(teamMutationFailureLabel(outcome.failure));
    }, [context]);

    // A segmented control reports its current option too; only a different choice is a change.
    const choose = <K extends 'sessionCreationPolicy' | 'externalSharingPolicy' | 'defaultSessionHistoryAccess'>(
        field: K,
        value: TeamPolicyField[K],
    ) => {
        if (!canEdit || policy[field] === value) return;
        void patch({ [field]: value } as Pick<TeamPolicyField, K>);
    };

    return (
        <>
            {error ? (
                <AttentionBanner
                    testID="team-settings-policy-error"
                    title={t('homeGovernance.changeFailedTitle')}
                    description={error}
                    accessibilityLiveRegion="assertive"
                />
            ) : null}
            {/* Sharing (DR-18, lab `tsSettings-A`): each policy is one row with a segmented choice of
                short options and, beneath its name, what the current choice means. A choice applies
                as soon as it is made; nothing already shared changes. */}
            <ItemGroup
                title={t('teams.settings.sharingSection')}
                description={t('teams.settings.sharingDescription')}
            >
                {readOnly ? (
                    <>
                        {/* A viewer who cannot change these, or an archived Team, reads each value
                            as text with what it means (lab `tsSettings-D`/`R`), never a dimmed control. */}
                        <Item
                            testID="team-settings-session-creation"
                            title={t('teams.settings.sessionDefaultsSection')}
                            subtitle={sessionCreationConsequence(policy.sessionCreationPolicy, teamName)}
                            subtitleLines={0}
                            detail={sessionCreationLabel(policy.sessionCreationPolicy)}
                            mode="info"
                            showChevron={false}
                        />
                        <Item
                            testID="team-settings-external-sharing"
                            title={t('teams.settings.externalSharingSection')}
                            subtitle={externalSharingConsequence(policy.externalSharingPolicy, teamName)}
                            subtitleLines={0}
                            detail={externalSharingLabel(policy.externalSharingPolicy)}
                            mode="info"
                            showChevron={false}
                        />
                        <Item
                            testID="team-settings-history-default"
                            title={t('teams.settings.historyDefaultSection')}
                            subtitle={historyConsequence(policy.defaultSessionHistoryAccess, teamName)}
                            subtitleLines={0}
                            detail={historyLabel(policy.defaultSessionHistoryAccess)}
                            mode="info"
                            showChevron={false}
                        />
                    </>
                ) : (
                    <>
                        <SegmentedChoiceItem<TeamSessionCreationPolicyV1>
                            testID="team-settings-session-creation"
                            title={t('teams.settings.sessionDefaultsSection')}
                            subtitleLines={0}
                            options={SESSION_CREATION_OPTIONS.map((option) => ({
                                id: option,
                                label: sessionCreationLabel(option),
                                description: sessionCreationConsequence(option, teamName),
                            }))}
                            value={policy.sessionCreationPolicy}
                            onChange={(option) => choose('sessionCreationPolicy', option)}
                            disabled={!canEdit}
                            testIDPrefix="team-settings-session-creation"
                        />
                        <SegmentedChoiceItem<TeamExternalSharingPolicyV1>
                            testID="team-settings-external-sharing"
                            title={t('teams.settings.externalSharingSection')}
                            subtitleLines={0}
                            options={EXTERNAL_SHARING_OPTIONS.map((option) => ({
                                id: option,
                                label: externalSharingLabel(option),
                                description: externalSharingConsequence(option, teamName),
                            }))}
                            value={policy.externalSharingPolicy}
                            onChange={(option) => choose('externalSharingPolicy', option)}
                            disabled={!canEdit}
                            testIDPrefix="team-settings-external-sharing"
                        />
                        <SegmentedChoiceItem<SessionHistoryAccessV1>
                            testID="team-settings-history-default"
                            title={t('teams.settings.historyDefaultSection')}
                            subtitleLines={0}
                            options={HISTORY_OPTIONS.map((option) => ({
                                id: option,
                                label: historyLabel(option),
                                description: historyConsequence(option, teamName),
                            }))}
                            value={policy.defaultSessionHistoryAccess}
                            onChange={(option) => choose('defaultSessionHistoryAccess', option)}
                            disabled={!canEdit}
                            testIDPrefix="team-settings-history-default"
                        />
                    </>
                )}
            </ItemGroup>
        </>
    );
});

const TeamLifecycleSection = React.memo(function TeamLifecycleSection(props: Readonly<{
    context: TeamSectionContext;
}>) {
    const router = useRouter();
    const { context } = props;
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const lifecycleInFlightRef = React.useRef(false);
    const name = context.team.name;

    React.useEffect(() => () => {
        lifecycleInFlightRef.current = false;
    }, []);

    const archive = React.useCallback(async () => {
        if (lifecycleInFlightRef.current) return;
        lifecycleInFlightRef.current = true;
        // The consequence in three plain lines (lab `tsSettings-X`): what is kept, the one thing
        // that does not come back, and the way back.
        const confirmed = await Modal.confirm(
            t('teams.archive.confirmTitle', { name }),
            teamArchiveConfirmationLines(context.team).join('\n'),
            // Destructive styling appears only at the final confirmation.
            { confirmText: t('teams.archive.action', { name }), destructive: true },
        );
        if (!confirmed) {
            lifecycleInFlightRef.current = false;
            return;
        }
        setBusy(true);
        setError(null);
        let outcome: Awaited<ReturnType<typeof archiveTeam>>;
        try {
            outcome = await archiveTeam({
                scope: context.scope,
                address: context.address,
            });
        } catch (cause) {
            if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.artifactId);
            else setError(t('teams.errors.generic'));
            setBusy(false);
            lifecycleInFlightRef.current = false;
            return;
        }
        setBusy(false);
        lifecycleInFlightRef.current = false;
        if (outcome.kind === 'failed') { setError(teamMutationFailureLabel(outcome.failure)); return; }
        router.back();
    }, [context, name, router]);

    const restore = React.useCallback(async () => {
        if (lifecycleInFlightRef.current) return;
        lifecycleInFlightRef.current = true;
        const confirmed = await Modal.confirm(
            t('teams.archive.restoreTitle', { name }),
            t('teams.archive.restoreBody'),
            { confirmText: t('teams.archive.restoreAction', { name }) },
        );
        if (!confirmed) {
            lifecycleInFlightRef.current = false;
            return;
        }
        setBusy(true);
        setError(null);
        let outcome: Awaited<ReturnType<typeof restoreTeam>>;
        try {
            outcome = await restoreTeam({
                scope: context.scope,
                address: context.address,
            });
        } catch (cause) {
            if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.artifactId);
            else setError(t('teams.errors.generic'));
            setBusy(false);
            lifecycleInFlightRef.current = false;
            return;
        }
        setBusy(false);
        lifecycleInFlightRef.current = false;
        if (outcome.kind === 'failed') setError(teamMutationFailureLabel(outcome.failure));
    }, [context, name]);

    // Restore stays reachable from the archived Team; archive does not.
    const showArchive = context.team.capabilities.archiveTeam && !context.archived;
    const showRestore = context.team.capabilities.restoreTeam && context.archived;

    // Archived (lab `tsSettings-R`): one banner says the Team's condition and carries Restore, the
    // page's one action. It leads the page, so it is this section's whole output.
    if (context.archived) {
        return (
            <AttentionBanner
                testID="team-settings-archived"
                tone="neutral"
                title={t('teams.archive.archivedTitle', { name })}
                description={error ?? t('teams.archive.archivedBody')}
                accessibilityLiveRegion={error ? 'assertive' : undefined}
                action={showRestore ? {
                    label: t('teams.archive.restoreAction', { name }),
                    onPress: () => void restore(),
                    testID: 'team-settings-restore',
                    loading: busy,
                    disabled: busy || !context.mutationsAvailable || context.approvalPending,
                } : null}
            />
        );
    }
    if (!showArchive) return null;

    // Archive closes the page as a quiet destructive button at the far edge with its consequence
    // beneath (lab `tsSettings-A`); the page's last row is where a Team's irreversible actions live.
    return (
        <ItemGroup surface="none">
            <SectionButtonRow
                footnote={error ?? t('teams.settings.archiveDescription')}
                footnoteTone={error ? 'danger' : 'secondary'}
                footnoteTestID={error ? 'team-settings-lifecycle-error' : undefined}
                trailing={(
                    <RoundButton
                        testID="team-settings-archive"
                        size="small"
                        display="destructive"
                        title={t('teams.archive.action', { name })}
                        titleNumberOfLines="complete"
                        loading={busy}
                        disabled={busy || !context.canMutate}
                        onPress={() => void archive()}
                    />
                )}
            >
                {null}
            </SectionButtonRow>
        </ItemGroup>
    );
});

/**
 * Who to ask (lab `tsSettings-D`): a viewer who can change nothing here is told who can, by name,
 * above the values they can still read. Mounted only for that viewer, so the roster read behind the
 * names runs only then.
 */
const TeamSettingsReadOnlyBanner = React.memo(function TeamSettingsReadOnlyBanner(props: Readonly<{
    context: TeamSectionContext;
}>) {
    const names = useTeamManagerNames(props.context, true);
    return (
        <AttentionBanner
            testID="team-settings-read-only"
            tone="neutral"
            icon={<Icon name="lock" />}
            title={t('teams.denied.settings', { team: props.context.team.name })}
            description={askTeamManagersText(names)}
        />
    );
});

export const TeamSettingsScreen = React.memo(function TeamSettingsScreen(props: Readonly<{
    serverId: string;
    teamId: string;
}>) {
    return (
        <TeamSection
            serverId={props.serverId}
            teamId={props.teamId}
            title={t('teams.tabs.settings')}
            description={t('teams.pages.settings')}
            restoresHere
        >
            {(context) => (
                <>
                    {/* A viewer who can change none of this still sees what the Team is set to and who
                        changes it, rather than an empty page (lab `tsSettings-D`). */}
                    {context.archived ? (
                        <TeamLifecycleSection context={context} />
                    ) : !context.team.capabilities.manageSettings && !context.team.capabilities.managePolicy ? (
                        <TeamSettingsReadOnlyBanner context={context} />
                    ) : null}
                    {/* The Team section carries the logo row with the name and description. An
                        archived Team shows them as text, like every other value on the page. */}
                    {context.team.capabilities.manageSettings && !context.archived
                        ? <TeamIdentitySection context={context} />
                        : <TeamIdentityFacts context={context} />}
                    <TeamPolicySections context={context} />
                    {context.archived ? null : <TeamLifecycleSection context={context} />}
                </>
            )}
        </TeamSection>
    );
});

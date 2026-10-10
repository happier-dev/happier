import * as React from 'react';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
    TEAM_GROUP_NAME_MAX_LENGTH_V1,
    validateTeamGroupDescriptionV1,
    validateTeamGroupNameV1,
} from '@happier-dev/protocol/teams';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { randomUUID } from '@/platform/randomUUID';
import { createTeamGroup } from '@/sync/ops/teams/teamGroupOperations';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { t } from '@/text';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import { teamMutationFailureLabel } from '../teamMutationPresentation';
import { teamGroupDetailPath } from '../teamsRoutes';

const CreateGroupForm = React.memo(function CreateGroupForm(props: Readonly<{
    context: TeamSectionContext;
}>) {
    const router = useRouter();
    const navigation = useNavigation();
    const { context } = props;
    const [name, setName] = React.useState('');
    const [description, setDescription] = React.useState('');
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const submitInFlightRef = React.useRef(false);
    const nameInputRef = React.useRef<React.ComponentRef<typeof FieldTextInput> | null>(null);
    const descriptionInputRef = React.useRef<React.ComponentRef<typeof FieldTextInput> | null>(null);

    React.useEffect(() => () => {
        submitInFlightRef.current = false;
    }, []);

    // One retry identity per submission; a lost response must not create two
    // Groups, and it is regenerated only when the payload changes.
    const requestKey = React.useRef(randomUUID());
    React.useEffect(() => {
        requestKey.current = randomUUID();
    }, [name, description]);

    const nameValidation = validateTeamGroupNameV1(name);
    const descriptionValidation = validateTeamGroupDescriptionV1(description);
    const { allowSavedNavigation } = useUnsavedDraftNavigationGuard({
        navigation,
        isDirty: name.length > 0 || description.length > 0,
        tag: 'TeamGroupCreateScreen.beforeRemove',
    });

    /**
     * One settlement for the immediate answer and the approved one. The Group's
     * id exists only in the Home's answer, so an approved creation opens the
     * Group it actually produced rather than degrading into "something changed".
     */
    const openCreatedGroup = React.useCallback((group: Readonly<{ id: string }>) => {
        allowSavedNavigation();
        router.replace(teamGroupDetailPath(context.address, group.id));
    }, [allowSavedNavigation, context.address, router]);

    const submit = React.useCallback(async () => {
        if (submitInFlightRef.current) return;
        // The canonical validators decide, and the person is told which field
        // to fix: a submit that returns silently is indistinguishable from a
        // request that was sent and lost.
        if (nameValidation.status !== 'ok') {
            nameInputRef.current?.focus();
            return;
        }
        if (descriptionValidation.status !== 'ok') {
            descriptionInputRef.current?.focus();
            return;
        }
        submitInFlightRef.current = true;
        setSubmitting(true);
        setError(null);
        let outcome: Awaited<ReturnType<typeof createTeamGroup>>;
        try {
            outcome = await createTeamGroup({
                scope: context.scope,
                address: context.address,
                name: nameValidation.name,
                description: descriptionValidation.description,
                requestKey: requestKey.current,
                onApprovalSucceeded: openCreatedGroup,
                onApprovalFailed: () => setError(t('teams.errors.generic')),
            });
        } catch (cause) {
            submitInFlightRef.current = false;
            setSubmitting(false);
            if (isTeamActionApprovalPendingError(cause)) {
                // The creation was deferred, not lost. Registering this exact
                // request is what lets its approved answer open the new Group
                // here; settlement never redispatches, because the Home creates
                // the Group when the approval is granted.
                context.requestApproval(cause.registration);
            } else {
                setError(t('teams.errors.generic'));
            }
            return;
        }
        submitInFlightRef.current = false;
        setSubmitting(false);
        if (outcome.kind === 'succeeded') {
            openCreatedGroup(outcome.value);
            return;
        }
        // A name collision inside this Team is the one failure worth naming
        // precisely; the form is preserved either way.
        setError(outcome.failure.kind === 'conflict'
            ? t('teams.groups.nameTaken')
            : outcome.failure.kind === 'invalid'
                ? t('teams.errors.invalidName')
                : teamMutationFailureLabel(outcome.failure));
    }, [context, nameValidation, descriptionValidation, openCreatedGroup]);

    if (!context.team.capabilities.manageGroups) {
        return (
            <ItemGroup>
                <SurfaceStateCard
                    testID="team-group-create-forbidden"
                    kind="denied"
                    size="line"
                    title={t('teams.denied.title')}
                />
            </ItemGroup>
        );
    }

    return (
        <>
            <ItemGroup title={t('teams.groups.detailsSection')}>
                <Item
                    title={t('teams.groups.nameLabel')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            ref={nameInputRef}
                            testID="team-group-create-name"
                            value={name}
                            onChangeText={setName}
                            placeholder={t('teams.groups.namePlaceholder')}
                            accessibilityLabel={t('teams.groups.nameLabel')}
                            maxLength={TEAM_GROUP_NAME_MAX_LENGTH_V1}
                            autoFocus
                        />
                    )}
                />
                <Item
                    title={t('teams.create.descriptionLabel')}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            ref={descriptionInputRef}
                            testID="team-group-create-description"
                            value={description}
                            onChangeText={setDescription}
                            placeholder={t('teams.groups.descriptionPlaceholder')}
                            accessibilityLabel={t('teams.create.descriptionLabel')}
                            multiline
                            minLines={2}
                            error={descriptionValidation.status !== 'ok' ? t('teams.errors.invalidDescription') : null}
                        />
                    )}
                />
            </ItemGroup>

            <ItemGroup surface="none">
                <SectionButtonRow footnote={error} footnoteTone="danger" footnoteTestID="team-group-create-error">
                    <RoundButton
                        testID="team-group-create-submit"
                        size="small"
                        title={t('teams.groups.submit')}
                        loading={submitting}
                        // The description is as much a reason to withhold Create as
                        // the name: the text is preserved, the field says what is
                        // wrong, and no request is issued that the Home would refuse.
                        disabled={nameValidation.status !== 'ok'
                            || descriptionValidation.status !== 'ok'
                            || submitting
                            || !context.canMutate}
                        onPress={() => void submit()}
                    />
                </SectionButtonRow>
            </ItemGroup>
        </>
    );
});

export const TeamGroupCreateScreen = React.memo(function TeamGroupCreateScreen(props: Readonly<{
    serverId: string;
    teamId: string;
}>) {
    return (
        <TeamSection
            serverId={props.serverId}
            teamId={props.teamId}
            title={t('teams.groups.create')}
            description={t('teams.pages.newGroup')}
        >
            {(context) => <CreateGroupForm context={context} />}
        </TeamSection>
    );
});

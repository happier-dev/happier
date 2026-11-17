import * as React from 'react';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { ResolvedInheritedManagedSessionDefaults } from '@happier-dev/protocol/teams/managedDefaults';

import {
  ApprovalProfileSelect,
  approvalProfileChoiceTitle,
  type ApprovalProfileDefaultChoices,
} from '@/components/approvals/ApprovalProfileSelect';
import { sharePrincipalKey } from '@/components/sharing/sharePrincipalPresentation';
import { useSharePrincipalNames } from '@/components/sharing/sharePrincipalNames';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { useApprovalProfileDefault } from '@/hooks/approvals/useApprovalProfileDefault';
import { useApprovalProfiles } from '@/hooks/approvals/useApprovalProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { describeInheritedDefaultSource } from './inheritedDefaultSourceLabel';

type ProfileChoice = string | null | undefined;

/**
 * The approval profile a Team's, Group's or project's new sessions suggest (OQ7: members keep their own until they
 * choose it). Absent inherits the layer above, None deliberately sets none. A picked profile the audience cannot see
 * yet is offered for sharing in the same step; the Artifact owner decides who is missing, this row never re-checks it.
 */
export const ApprovalProfileDefaultRow = React.memo(
  function ApprovalProfileDefaultRow(
    props: Readonly<{
      /** The Account that owns the picked profile: the Team section's exact scope, or the project's Home. */
      scopeOrHome: ServerAccountScope | string;
      value: ProfileChoice;
      /** Who the default reaches; absent when it is only mine (a project's "For me"). */
      audience?: readonly PrincipalRefV1[];
      /** What absent restores and whose it is (project scopes only). */
      inherited?:
        | ResolvedInheritedManagedSessionDefaults['approvalProfileId']
        | null;
      description?: string;
      conflictNote?: string;
      editable: boolean;
      disabled: boolean;
      save: (value: ProfileChoice) => Promise<void> | void;
      testID: string;
    }>,
  ) {
    const inheritedId =
      typeof props.inherited?.value === 'string' ? props.inherited.value : null;
    const source = useApprovalProfiles(
      typeof props.value === 'string'
        ? props.value
        : (inheritedId ?? undefined),
      props.scopeOrHome,
      { demand: false },
    );
    const scope = source.execution.binding?.scope ?? null;
    const save = React.useCallback(
      async (value: ProfileChoice) => {
        await props.save(value);
      },
      [props.save],
    );
    const choice = useApprovalProfileDefault({
      scope,
      value: props.value,
      audience: props.audience,
      save,
    });
    const [failure, setFailure] = React.useState<'sharing' | 'save' | null>(
      null,
    );
    const submitting = React.useRef(false);
    const submit = React.useCallback(
      async (decision: 'share' | 'save_only' | 'cancel') => {
        if (submitting.current) return;
        submitting.current = true;
        try {
          const result = await choice.submit(decision);
          setFailure(
            result.ok || result.phase === 'cancelled' ? null : result.phase,
          );
        } finally {
          submitting.current = false;
        }
      },
      [choice.submit],
    );
    const { draft, review } = choice;
    const missing =
      draft && review.required ? review.missingAudience : undefined;
    // Nothing to share (no audience, None or inherited, or everyone already sees it): the pick saves at once.
    const settledWithoutSharing =
      draft !== null &&
      (!review.required ||
        (!review.loading &&
          review.issue == null &&
          missing !== undefined &&
          missing.length === 0));
    React.useEffect(() => {
      if (settledWithoutSharing) void submit('save_only');
    }, [settledWithoutSharing, submit]);

    const names = useSharePrincipalNames(
      missing && missing.length > 0 ? missing : null,
      source.execution.binding?.scope.serverId ?? null,
    );
    const audienceLabel = (missing ?? [])
      .map(
        (principal) =>
          names.names?.get(sharePrincipalKey(principal)) ??
          t(
            principal.kind === 'group'
              ? 'teams.settings.memberDefaults.approvalProfileAudienceGroup'
              : 'teams.settings.memberDefaults.approvalProfileAudienceTeam',
          ),
      )
      .join(', ');

    const shown = draft ? draft.value : props.value;
    const inheritedName = inheritedId
      ? (source.displayProfiles.find((profile) => profile.id === inheritedId)
          ?.name ?? null)
      : null;
    const restoreSource =
      props.inherited && inheritedId
        ? describeInheritedDefaultSource(
            props.inherited.source,
            props.inherited.names,
          )
        : null;
    const defaultChoices = React.useMemo<ApprovalProfileDefaultChoices>(
      () => ({
        inherit: inheritedName
          ? {
              title: t('teams.settings.memberDefaults.useDefault', {
                value: inheritedName,
              }),
              subtitle: restoreSource ?? undefined,
              detail: inheritedName,
            }
          : {
              title: t('teams.settings.memberDefaults.approvalProfileNotSet'),
              subtitle: t(
                'teams.settings.memberDefaults.approvalProfileNotSetDescription',
              ),
              detail: t('teams.settings.memberDefaults.approvalProfileNotSet'),
            },
        none: {
          title: t('teams.settings.memberDefaults.none'),
          subtitle: t(
            'teams.settings.memberDefaults.approvalProfileNoneDescription',
          ),
        },
      }),
      [inheritedName, restoreSource],
    );
    const description =
      [
        props.value === undefined && inheritedName ? restoreSource : null,
        props.description,
        props.conflictNote,
      ]
        .filter(Boolean)
        .join(' ') || undefined;
    const title = t('teams.settings.memberDefaults.approvalProfile');

    if (!props.editable) {
      return (
        <Item
          testID={props.testID}
          title={title}
          subtitle={description}
          subtitleLines={0}
          mode="info"
          showChevron={false}
          detail={approvalProfileChoiceTitle(
            'default',
            props.value,
            source.displayProfiles,
            null,
            defaultChoices,
          )}
        />
      );
    }
    const profileName =
      typeof draft?.value === 'string'
        ? (source.displayProfiles.find((profile) => profile.id === draft.value)
            ?.name ?? null)
        : null;
    const offerShare = missing !== undefined && missing.length > 0;
    const shareIssue =
      failure === 'sharing' ||
      (draft !== null && review.required && review.issue != null);
    return (
      <>
        <ApprovalProfileSelect
          mode="default"
          testID={props.testID}
          source={source}
          value={shown}
          defaultChoices={defaultChoices}
          description={description}
          layout="adaptive"
          disabled={props.disabled || draft !== null}
          onChange={(value) => {
            setFailure(null);
            choice.choose(value);
          }}
        />
        {draft && (offerShare || shareIssue) ? (
          <AttentionBanner
            testID={`${props.testID}-share`}
            tone={shareIssue ? 'warning' : 'neutral'}
            placement="inline"
            iconName={shareIssue ? undefined : 'users'}
            title={
              shareIssue
                ? t('teams.settings.memberDefaults.approvalProfileShareFailed')
                : t('teams.settings.memberDefaults.approvalProfileShareTitle', {
                    profile:
                      profileName ??
                      t('teams.settings.memberDefaults.approvalProfile'),
                    audience: audienceLabel,
                  })
            }
            description={
              shareIssue
                ? undefined
                : t('teams.settings.memberDefaults.approvalProfileShareBody')
            }
            action={{
              label: t(
                shareIssue
                  ? 'common.retry'
                  : 'teams.settings.memberDefaults.approvalProfileShare',
              ),
              onPress: () => {
                if (review.issue != null && failure !== 'sharing')
                  review.retry();
                else void submit('share');
              },
              testID: `${props.testID}-share.share`,
            }}
            secondaryAction={{
              label: t(
                'teams.settings.memberDefaults.approvalProfileUseWithoutSharing',
              ),
              onPress: () => {
                void submit('save_only');
              },
              testID: `${props.testID}-share.saveOnly`,
            }}
            onDismiss={() => {
              void submit('cancel');
            }}
          />
        ) : null}
      </>
    );
  },
);

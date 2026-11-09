import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import { Icon } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { Text } from '@/components/ui/text/Text';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { t } from '@/text';

import { useApprovalAccountLabel } from './ApprovalRequesterConfirmationSection';

type CredentialUse = ActionOperationCredentialUseV1;

function usingText(use: CredentialUse): string {
  if (use.label)
    return t('detailPages.approval.requester.thread.using', {
      label: use.label,
    });
  return use.kind === 'team_resource'
    ? t('detailPages.approval.requester.thread.usingTeam')
    : t('detailPages.approval.requester.thread.usingAccount');
}

function AccountOwner(
  props: Readonly<{ serverId: string; accountId: string }>,
) {
  const name = useApprovalAccountLabel(
    props.serverId,
    props.accountId,
    'sentence',
  );
  return name ? (
    <Text variant="meta" style={styles.detail}>
      {t('detailPages.approval.requester.thread.ownerAccount', { name })}
    </Text>
  ) : null;
}

/** Mounted only once the person opens the detail, so a closed card reads no Teams directory. */
function TeamOwner(props: Readonly<{ serverId: string; teamId: string }>) {
  const teams = useTeamsDirectory({ serverIds: [props.serverId] });
  const name =
    teams.rows.find((row) => row.team.id === props.teamId)?.team.name ?? null;
  return (
    <Text variant="meta" style={styles.detail}>
      {name
        ? t('detailPages.approval.requester.thread.ownerTeam', { name })
        : t('detailPages.approval.requester.thread.ownerTeamUnnamed')}
    </Text>
  );
}

function OperationActorUse(
  props: Readonly<{ use: CredentialUse; serverId: string; testID: string }>,
) {
  const { use } = props;
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  return (
    <ExpandableItem
      expanded={open}
      onExpandedChange={setOpen}
      showDivider={false}
      header={({ headerProps, expanded }) => (
        <Pressable
          {...headerProps}
          testID={props.testID}
          accessibilityLabel={usingText(use)}
          style={styles.header}
        >
          <Icon name="key" size={14} color={theme.colors.text.secondary} />
          <Text variant="meta" style={styles.fact} numberOfLines={1}>
            {usingText(use)}
          </Text>
          <DisclosureCaret expanded={expanded} />
        </Pressable>
      )}
    >
      <View style={styles.details}>
        {use.owner?.kind === 'account' ? (
          <AccountOwner
            serverId={props.serverId}
            accountId={use.owner.accountId}
          />
        ) : use.owner?.kind === 'team' ? (
          <TeamOwner serverId={props.serverId} teamId={use.owner.teamId} />
        ) : null}
        <Text variant="meta" style={styles.detail}>
          {t('detailPages.approval.requester.thread.why')}
        </Text>
      </View>
    </ExpandableItem>
  );
}

/**
 * C7 "Using <admitted label>": the credential the operation actually ran with, from the receipt's
 * admission facts alone. It is neither the requester nor the execution Account, so it never
 * guesses: no admitted evidence draws nothing, and an unlabeled credential is named by its kind.
 * Owner and why wait behind the line.
 */
export function ApprovalOperationActorLine(
  props: Readonly<{
    uses: readonly CredentialUse[] | undefined;
    /** The Home the request was made on: it qualifies the owner Account/Team. */
    serverId: string;
  }>,
) {
  if (!props.uses?.length) return null;
  return (
    <View style={styles.list}>
      {props.uses.map((use, index) => (
        <OperationActorUse
          key={index}
          use={use}
          serverId={props.serverId}
          testID={`approval-operation-actor${index === 0 ? '' : `-${index}`}`}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.space.s2 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.space.s6,
    flexShrink: 1,
  },
  fact: {
    flexShrink: 1,
    color: theme.colors.text.secondary,
  },
  details: {
    paddingTop: theme.space.s4,
    paddingLeft: theme.space.s6 + 14,
    gap: theme.space.s2,
  },
  detail: {
    color: theme.colors.text.secondary,
  },
}));

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { DiffStat } from '@/components/workspaces/scm/DiffStat';
import { t } from '@/text';

import type { SessionListRowContextPresentation } from '../sessionListRowViewModels';

type SessionRowPullRequest = NonNullable<
  SessionListRowContextPresentation['pullRequest']
>;
type SessionRowChanges = NonNullable<
  SessionListRowContextPresentation['changes']
>;

/**
 * A Session row's pull request (lab ideas-1118-shell scene 7): the state glyph, its number and the checks summary in
 * the row's quiet ink. Running checks draw a small dot, so the row never shows three look-alike circles (the working
 * spinner, the progress ring, the checks). It draws only from the SCM value the list already holds for the checkout.
 */
export const SessionRowPullRequestChip = React.memo(
  function SessionRowPullRequestChip(
    props: Readonly<{
      pullRequest: SessionRowPullRequest;
      testID?: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const { state, checks } = props.pullRequest;
    const quiet = theme.colors.text.tertiary;
    return (
      <View testID={props.testID} style={styles.chip}>
        <Icon
          name={state === 'merged' ? 'git-merge' : 'git-pull-request'}
          size={12}
          color={quiet}
        />
        {props.pullRequest.number !== null ? (
          <Text style={styles.text}>
            {t('sessionGitPullRequest.card.number', {
              number: props.pullRequest.number,
            })}
          </Text>
        ) : null}
        {checks === 'failure' ? (
          <Icon
            name="x"
            size={11}
            color={theme.colors.state.danger.foreground}
          />
        ) : checks === 'success' ? (
          <Icon name="check" size={11} color={quiet} />
        ) : checks === 'pending' ? (
          <View
            testID={props.testID ? `${props.testID}:checks-running` : undefined}
            style={styles.pending}
          />
        ) : null}
      </View>
    );
  },
);

/** The row's changes (+/−): the shared diff stat in the row's quiet inks (lab scene 7, line 3 only). */
export const SessionRowChangesStat = React.memo(function SessionRowChangesStat(
  props: Readonly<{
    changes: SessionRowChanges;
    testID?: string;
  }>,
) {
  return (
    <DiffStat
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      added={props.changes.linesAdded}
      removed={props.changes.linesRemoved}
      renderCount={(kind, text, style) => (
        <Text
          key={kind}
          style={[style, kind === 'added' ? styles.added : styles.removed]}
        >
          {text}
        </Text>
      )}
    />
  );
});

/** What the row's pull request and changes say to assistive technology. */
export function describeSessionRowScm(
  pullRequest: SessionRowPullRequest | null,
  changes: SessionRowChanges | null,
): string | null {
  const parts = [
    pullRequest
      ? [
          t('files.sourceControlOperations.update.pullRequest.title'),
          pullRequest.number !== null
            ? t('sessionGitPullRequest.card.number', {
                number: pullRequest.number,
              })
            : null,
          t(`sessionGitPullRequest.card.state.${pullRequest.state}` as const),
          pullRequest.checks
            ? t(
                `sessionGitPullRequest.card.checks.${pullRequest.checks}` as const,
              )
            : null,
        ]
          .filter(Boolean)
          .join(' ')
      : null,
    changes
      ? `${t('sessionGitPane.subTabs.changes')} +${changes.linesAdded} −${changes.linesRemoved}`
      : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : null;
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  text: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.tertiary,
  },
  pending: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: theme.colors.text.tertiary,
  },
  added: {
    color: theme.colors.text.secondary,
  },
  removed: {
    color: theme.colors.text.tertiary,
  },
}));

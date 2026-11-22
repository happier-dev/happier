import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ScmBranchListEntry } from '@happier-dev/protocol/scm/branches';

import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { repoScmBranchService } from '@/scm/repository/repoScmBranchService';
import { useRepoScmBranchList } from '@/scm/repository/useRepoScmBranchList';
import {
  useSessionProjectScmSummarySnapshot,
  useWorkspaceScmSummarySnapshot,
} from '@/sync/domains/state/storage';
import { t } from '@/text';

/** Where the reviewed changes live: a Session's checkout, or the Machine folder a global start chose. */
export type ReviewStartBranchSource = Readonly<{
  sessionId: string | null;
  serverId: string | null;
  workspace?: Readonly<{ machineId: string; cwd: string }>;
}>;

/**
 * The checkout's branch facts for "A branch" (lab `start-branch`): the branch under review and the base the
 * repository names by default. Read from the same SCM summary the start's scope line already observes.
 */
export function useReviewStartBranchFacts(
  source: ReviewStartBranchSource,
): Readonly<{ head: string | null; defaultBase: string | null }> {
  const sessionSnapshot = useSessionProjectScmSummarySnapshot(
    source.sessionId,
    source.serverId,
  );
  const workspaceSnapshot = useWorkspaceScmSummarySnapshot(
    source.sessionId === null && source.serverId && source.workspace
      ? {
          serverId: source.serverId,
          machineId: source.workspace.machineId,
          rootPath: source.workspace.cwd,
        }
      : null,
  );
  const snapshot = sessionSnapshot ?? workspaceSnapshot;
  const head = snapshot?.branch.head ?? null;
  const defaultBranch = snapshot?.repo.defaultBranch ?? null;
  return {
    head,
    defaultBase: defaultBranch && defaultBranch !== head ? defaultBranch : null,
  };
}

const NO_BRANCHES: ReadonlyArray<ScmBranchListEntry> = [];

/**
 * "Compare with ⟨base⟩": the base a branch review diffs against, picked from the checkout's branches through the
 * existing SCM branch read. It mounts only once a branch review is chosen, so the read starts then, not when the sheet
 * opens. Presentation of the one draft field the host owns.
 */
export function ReviewStartBranchBase(
  props: ReviewStartBranchSource &
    Readonly<{
      head: string | null;
      value: string | null;
      onChange: (branch: string) => void;
      disabled?: boolean;
    }>,
) {
  const { sessionId, serverId, workspace } = props;
  const readCached = React.useCallback(
    () =>
      sessionId
        ? repoScmBranchService.readCachedBranchesForSession({
            sessionId,
            serverId,
          })
        : workspace
          ? repoScmBranchService.readCachedBranchesForMachinePath({
              serverId,
              machineId: workspace.machineId,
              path: workspace.cwd,
            })
          : NO_BRANCHES,
    [serverId, sessionId, workspace],
  );
  const fetch = React.useCallback(
    () =>
      sessionId
        ? repoScmBranchService.fetchBranchesForSession({ sessionId, serverId })
        : workspace
          ? repoScmBranchService.fetchBranchesForMachinePath({
              serverId,
              machineId: workspace.machineId,
              path: workspace.cwd,
            })
          : Promise.resolve(NO_BRANCHES),
    [serverId, sessionId, workspace],
  );
  const list = useRepoScmBranchList({
    ready: sessionId !== null || workspace !== undefined,
    autoLoad: true,
    readCached,
    fetch,
  });
  const items = React.useMemo(() => {
    const names = new Set<string>();
    if (props.value) names.add(props.value);
    for (const branch of list.branches)
      if (!branch.isCurrent && branch.name !== props.head) names.add(branch.name);
    return Array.from(names, (name) => ({ id: name, title: name }));
  }, [list.branches, props.head, props.value]);
  return (
    <View testID="review-start-branch-base" style={styles.row}>
      <Text style={styles.label}>
        {t('reviewWalkthrough.start.compareWith')}
      </Text>
      <ValueFieldSelect
        testID="review-start-branch-base-select"
        label={t('reviewWalkthrough.start.compareWith')}
        items={items}
        selectedId={props.value}
        placeholder={t('reviewWalkthrough.start.chooseBranch')}
        searchPlaceholder={t('reviewWalkthrough.start.chooseBranch')}
        emptyLabel={list.phase === 'idle' ? undefined : t('common.loading')}
        onSelect={props.onChange}
        disabled={props.disabled}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    flexWrap: 'wrap',
  },
  label: { ...Typography.variant('body'), color: theme.colors.text.secondary },
}));

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';

import type { ProjectsListModel } from './useProjectsListModel';

/**
 * A Project change (rename, reset, Forget) that the person's Action policy sent for approval: one line
 * that says it is waiting and opens the approval itself, where it is decided. Nothing here assumes it
 * ran; the row changes only when the approved Action executes.
 */
export const ProjectActionApprovalNotice = React.memo(
  function ProjectActionApprovalNotice(
    props: Readonly<{
      testID?: string;
      request: ProjectsListModel['projectActionApproval'];
      onDismiss: () => void;
    }>,
  ) {
    const router = useRouter();
    const scope = useActiveServerAccountScope();
    if (!props.request || !scope) return null;
    const artifactId = props.request.artifactId;
    return (
      <View style={styles.container}>
        <SurfaceStateCard
          testID={props.testID ?? 'projects-action-approval'}
          size="line"
          kind="warning"
          iconName="clock"
          title={t('projects.identity.waitingForApproval')}
          accessibilitySemantics="status"
          action={{
            label: t('approvals.details'),
            testID: `${props.testID ?? 'projects-action-approval'}-open`,
            onPress: () => {
              props.onDismiss();
              router.push(
                `/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(scope.serverId)}`,
              );
            },
          }}
        />
      </View>
    );
  },
);

const styles = StyleSheet.create(() => ({
  container: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
}));

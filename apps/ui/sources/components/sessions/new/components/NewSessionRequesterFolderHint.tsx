import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { useMachineOwnIsolationStatus } from '@/hooks/machine/useMachineOwnIsolationStatus';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * A member starting a session on someone else's machine (MEMBER-WORKSPACE): the folder their session can
 * use is theirs, not the owner's. While that requester read runs the line says so; a failed read keeps its
 * one Retry; a separated member gets one quiet hint. On a machine that runs sessions as its owner, or with
 * no requester read, nothing is drawn. Sits with the launch notices, above the composer.
 */
export function NewSessionRequesterFolderHint(
  props: Readonly<{
    isolation: Pick<ReturnType<typeof useMachineOwnIsolationStatus>, 'status' | 'loading' | 'failed' | 'retry'> | undefined;
    testID?: string;
  }>,
): React.ReactElement | null {
  const isolation = props.isolation;
  const testID = props.testID ?? 'new-session-requester-folders';
  if (!isolation) return null;
  if (isolation.failed) {
    return (
      <View style={styles.slot}>
        <SurfaceStateCard
          testID={`${testID}.failed`}
          kind="warning"
          size="line"
          title={t('newSession.requesterFoldersFailed')}
          action={{
            label: t('common.retry'),
            onPress: isolation.retry,
            testID: `${testID}.failed.retry`,
          }}
        />
      </View>
    );
  }
  if (isolation.loading) {
    return (
      <View style={styles.slot}>
        <SurfaceStateCard
          testID={`${testID}.loading`}
          kind="loading"
          size="line"
          title={t('newSession.requesterFoldersChecking')}
        />
      </View>
    );
  }
  if (isolation.status?.protection !== 'member_separated') return null;
  return (
    <View style={styles.slot} testID={`${testID}.member`}>
      <Text style={styles.hint}>{t('newSession.requesterFoldersHint')}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    marginBottom: theme.space.s8,
  },
  hint: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));

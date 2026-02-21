import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import { Text } from '@/components/ui/text/Text';


export const ExecutionRunDetailsPanel = React.memo((props: Readonly<{
  run: ExecutionRunPublicState;
  daemonProcessLine?: string | null;
}>) => {
  const { theme } = useUnistyles();
  const { run } = props;

  return (
    <View style={{ gap: 6 }}>
      {props.daemonProcessLine ? (
        <Text style={{ color: theme.colors.textSecondary }}>
          {props.daemonProcessLine}
        </Text>
      ) : null}

      <View style={{ gap: 2 }}>
        <Text style={{ color: theme.colors.textSecondary }}>intent {(run as any).intent}</Text>
        <Text style={{ color: theme.colors.textSecondary }}>backendId {(run as any).backendId}</Text>
        {(run as any).permissionMode ? (
          <Text style={{ color: theme.colors.textSecondary }}>permissionMode {(run as any).permissionMode}</Text>
        ) : null}
        {(run as any).retentionPolicy ? (
          <Text style={{ color: theme.colors.textSecondary }}>retentionPolicy {(run as any).retentionPolicy}</Text>
        ) : null}
        {(run as any).runClass ? (
          <Text style={{ color: theme.colors.textSecondary }}>runClass {(run as any).runClass}</Text>
        ) : null}
        {(run as any).ioMode ? (
          <Text style={{ color: theme.colors.textSecondary }}>ioMode {(run as any).ioMode}</Text>
        ) : null}
      </View>

      {typeof run.startedAtMs === 'number' ? (
        <Text style={{ color: theme.colors.textSecondary }}>
          started {new Date(run.startedAtMs).toLocaleString()}
        </Text>
      ) : null}
      {typeof (run as any).finishedAtMs === 'number' ? (
        <Text style={{ color: theme.colors.textSecondary }}>
          finished {new Date((run as any).finishedAtMs).toLocaleString()}
        </Text>
      ) : null}
    </View>
  );
});


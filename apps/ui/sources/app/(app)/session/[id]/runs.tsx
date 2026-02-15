import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import { sessionExecutionRunList } from '@/sync/ops/sessionExecutionRuns';
import { t } from '@/text';
import { ExecutionRunList } from '@/components/sessions/runs/ExecutionRunList';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'loaded'; runs: readonly ExecutionRunPublicState[] };

function normalizeSessionId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim().length > 0) return value[0].trim();
  return null;
}

export default function SessionRunsScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const params = useLocalSearchParams();
  const sessionId = normalizeSessionId((params as any)?.id);

  const [state, setState] = React.useState<LoadState>({ status: 'loading' });

  const load = React.useCallback(async () => {
    if (!sessionId) {
      setState({ status: 'error', error: 'missing_session_id' });
      return;
    }

    setState({ status: 'loading' });
    const res = await sessionExecutionRunList(sessionId, {});
    if ((res as any)?.ok === false) {
      setState({ status: 'error', error: String((res as any).error ?? 'failed_to_list_runs') });
      return;
    }
    setState({ status: 'loaded', runs: (res as any).runs ?? [] });
  }, [sessionId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (!sessionId) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface, padding: 16 }}>
        <Text style={{ color: theme.colors.text }}>{t('errors.sessionDeleted')}</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface, padding: 16, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: theme.colors.text, fontSize: 18, fontWeight: '600' }}>
          {t('runs.title') ?? 'Runs'}
        </Text>
        <Pressable onPress={() => void load()}>
          <Text style={{ color: theme.colors.textSecondary }}>{t('common.refresh') ?? 'Refresh'}</Text>
        </Pressable>
      </View>

      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Run review"
          onPress={() => router.push(`/session/${sessionId}/runs/new?intent=review` as any)}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <Text style={{ color: theme.colors.textSecondary }}>Run review</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delegate task"
          onPress={() => router.push(`/session/${sessionId}/runs/new?intent=delegate` as any)}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <Text style={{ color: theme.colors.textSecondary }}>Delegate task</Text>
        </Pressable>
      </View>

      {state.status === 'loading' ? (
        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
      ) : state.status === 'error' ? (
        <Text style={{ color: theme.colors.textSecondary }}>{state.error}</Text>
      ) : (
        <ExecutionRunList
          runs={state.runs}
          onPressRun={(run) => {
            if (!sessionId) return;
            router.push(`/session/${sessionId}/runs/${run.runId}` as any);
          }}
        />
      )}
    </View>
  );
}

import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import { sessionExecutionRunList } from '@/sync/ops/sessionExecutionRuns';
import { t } from '@/text';
import { ExecutionRunList } from '@/components/sessions/runs/ExecutionRunList';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { Text } from '@/components/ui/text/Text';


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
  const headerTint = theme.colors.header?.tint ?? theme.colors.text;

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

  const headerRight = React.useCallback(() => {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Run review"
          onPress={() => {
            if (!sessionId) return;
            router.push(`/session/${sessionId}/runs/new?intent=review` as any);
          }}
          hitSlop={10}
          style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.7 : 1 })}
        >
          <Ionicons name="search-outline" size={20} color={headerTint} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delegate task"
          onPress={() => {
            if (!sessionId) return;
            router.push(`/session/${sessionId}/runs/new?intent=delegate` as any);
          }}
          hitSlop={10}
          style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.7 : 1 })}
        >
          <Ionicons name="person-add-outline" size={20} color={headerTint} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh runs"
          onPress={() => void load()}
          hitSlop={10}
          style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.7 : 1 })}
        >
          <Ionicons name="refresh" size={20} color={headerTint} />
        </Pressable>
      </View>
    );
  }, [headerTint, load, router, sessionId]);

  const screenOptions = React.useMemo(() => ({
    headerShown: true,
    headerTitle: 'Runs',
    headerRight,
  }), [headerRight]);

  if (!sessionId) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface, padding: 16 }}>
        <Text style={{ color: theme.colors.text }}>{t('errors.sessionDeleted')}</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.groupped?.background ?? theme.colors.surface }}>
      <Stack.Screen options={screenOptions} />
      <ConstrainedScreenContent
        style={{
          flex: 1,
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 16,
          gap: 12,
        }}
      >
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
      </ConstrainedScreenContent>
    </View>
  );
}

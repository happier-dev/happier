import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';
import { sessionExecutionRunList } from '@/sync/ops/sessionExecutionRuns';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { useExecutionRunsBackendsForSession } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import { t } from '@/text';
import { ExecutionRunList } from '@/components/sessions/runs/ExecutionRunList';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { Text } from '@/components/ui/text/Text';
import { getErrorMessage } from '@/utils/errors/getErrorMessage';
import { useSession } from '@/sync/domains/state/storage';


type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'loaded'; runs: readonly ExecutionRunPublicState[] };

function normalizeSessionId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim().length > 0) return value[0].trim();
  return null;
}

function readExecutionRunsErrorMessage(result: Readonly<{ error?: string; errorCode?: string }> | null | undefined): string {
  const message = getErrorMessage({
    message: typeof result?.error === 'string' ? result.error : undefined,
    rpcErrorCode: typeof result?.errorCode === 'string' ? result.errorCode : undefined,
  });
  return message || String(result?.error ?? 'failed_to_list_runs');
}

export default function SessionRunsScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const params = useLocalSearchParams();
  const sessionId = normalizeSessionId((params as any)?.id);
  const hydrateReady = useHydrateSessionForRoute(sessionId ?? '', 'SessionRunsScreen.hydrate');
  const executionRunsBackends = useExecutionRunsBackendsForSession(sessionId ?? '');
  const session = useSession(sessionId ?? '');

  const [state, setState] = React.useState<LoadState>({ status: 'loading' });
  const headerTint = theme.colors.header?.tint ?? theme.colors.text;
  const { canLaunchExecutionRuns } = useSessionExecutionRunLaunchability(sessionId ?? '', session);

  const load = React.useCallback(async () => {
    if (!sessionId) {
      setState({ status: 'error', error: 'missing_session_id' });
      return;
    }

    setState({ status: 'loading' });
      const first = await sessionExecutionRunList(sessionId, {});
      if ((first as any)?.ok === false) {
      if (!isRpcMethodNotAvailableError({
        message: typeof (first as any).error === 'string' ? (first as any).error : undefined,
        rpcErrorCode: typeof (first as any).errorCode === 'string' ? (first as any).errorCode : undefined,
      })) {
        setState({ status: 'error', error: readExecutionRunsErrorMessage(first as any) });
        return;
      }
      const retry = await sessionExecutionRunList(sessionId, {});
      if ((retry as any)?.ok === false) {
        setState({ status: 'error', error: readExecutionRunsErrorMessage(retry as any) });
        return;
      }
      setState({ status: 'loaded', runs: (retry as any).runs ?? [] });
      return;
    }
    setState({ status: 'loaded', runs: (first as any).runs ?? [] });
  }, [sessionId]);

  React.useEffect(() => {
    if (!hydrateReady) return;
    void load();
  }, [hydrateReady, load]);

  useFocusEffect(
    React.useCallback(() => {
      if (!hydrateReady) return;
      void load();
    }, [hydrateReady, load]),
  );

  const headerRight = React.useCallback(() => {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {canLaunchExecutionRuns ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('executionRuns.newRun.intents.review')}
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
              accessibilityLabel={t('executionRuns.newRun.intents.delegate')}
              onPress={() => {
                if (!sessionId) return;
                router.push(`/session/${sessionId}/runs/new?intent=delegate` as any);
              }}
              hitSlop={10}
              style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.7 : 1 })}
            >
              <Ionicons name="person-add-outline" size={20} color={headerTint} />
            </Pressable>
          </>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.refresh')}
          onPress={() => void load()}
          hitSlop={10}
          style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.7 : 1 })}
        >
          <Ionicons name="refresh" size={20} color={headerTint} />
        </Pressable>
      </View>
    );
  }, [canLaunchExecutionRuns, headerTint, load, router, sessionId]);

  const screenOptions = React.useMemo(() => ({
    headerShown: true,
    headerTitle: t('runs.title'),
    headerRight,
  }), [headerRight]);

  if (!sessionId) {
    return (
      <View testID="session-runs-screen" style={{ flex: 1, backgroundColor: theme.colors.surface, padding: 16 }}>
        <Text style={{ color: theme.colors.text }}>{t('errors.sessionDeleted')}</Text>
      </View>
    );
  }

  if (!hydrateReady) {
    return (
      <View testID="session-runs-screen" style={{ flex: 1, backgroundColor: theme.colors.groupped?.background ?? theme.colors.surface }}>
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
          <ActivityIndicator size="small" color={theme.colors.textSecondary} />
        </ConstrainedScreenContent>
      </View>
    );
  }

  return (
    <View testID="session-runs-screen" style={{ flex: 1, backgroundColor: theme.colors.groupped?.background ?? theme.colors.surface }}>
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

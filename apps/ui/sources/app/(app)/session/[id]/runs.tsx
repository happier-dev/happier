import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';
import { sessionExecutionRunList } from '@/sync/ops/sessionExecutionRuns';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import type { ExecutionRunBackendCapabilityMap } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';
import { t } from '@/text';
import { ExecutionRunList } from '@/components/sessions/runs/ExecutionRunList';
import { resolveExecutionRunLauncherIntents } from '@/components/sessions/runs/launcher/executionRunLauncherModel';
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
  const params = useLocalSearchParams();
  const sessionId = normalizeSessionId((params as any)?.id);
  const hydrateReady = useHydrateSessionForRoute(sessionId ?? '', 'SessionRunsScreen.hydrate');
  if (!hydrateReady) {
    return (
      <View testID="session-runs-screen" style={{ flex: 1, backgroundColor: theme.colors.groupped?.background ?? theme.colors.surface }}>
        <Stack.Screen options={{ headerShown: true, headerTitle: t('runs.title') }} />
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

  if (!sessionId) {
    return (
      <View testID="session-runs-screen" style={{ flex: 1, backgroundColor: theme.colors.surface, padding: 16 }}>
        <Text style={{ color: theme.colors.text }}>{t('errors.sessionDeleted')}</Text>
      </View>
    );
  }

  return <SessionRunsScreenContent sessionId={sessionId} />;
}

function SessionRunsScreenContent(props: Readonly<{ sessionId: string }>) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const session = useSession(props.sessionId);

  const [state, setState] = React.useState<LoadState>({ status: 'loading' });
  const loadGenerationRef = React.useRef(0);
  const headerTint = theme.colors.header?.tint ?? theme.colors.text;
  const { canLaunchExecutionRuns, executionRunsBackends } = useSessionExecutionRunLaunchability(props.sessionId, session);
  const launchIntents = React.useMemo(
    () => resolveExecutionRunLauncherIntents(executionRunsBackends as ExecutionRunBackendCapabilityMap),
    [executionRunsBackends],
  );
  const canShowLaunchButtons = canLaunchExecutionRuns && launchIntents.length > 0;

  const load = React.useCallback(async () => {
    const loadGeneration = ++loadGenerationRef.current;
    const commitState = (nextState: LoadState) => {
      if (loadGenerationRef.current !== loadGeneration) return;
      setState(nextState);
    };

    if (!props.sessionId) {
      commitState({ status: 'error', error: 'missing_session_id' });
      return;
    }

    commitState({ status: 'loading' });
    const first = await sessionExecutionRunList(props.sessionId, {});
    if ((first as any)?.ok === false) {
      if (!isRpcMethodNotAvailableError({
        message: typeof (first as any).error === 'string' ? (first as any).error : undefined,
        rpcErrorCode: typeof (first as any).errorCode === 'string' ? (first as any).errorCode : undefined,
      })) {
        commitState({ status: 'error', error: readExecutionRunsErrorMessage(first as any) });
        return;
      }
      const retry = await sessionExecutionRunList(props.sessionId, {});
      if ((retry as any)?.ok === false) {
        commitState({ status: 'error', error: readExecutionRunsErrorMessage(retry as any) });
        return;
      }
      commitState({ status: 'loaded', runs: (retry as any).runs ?? [] });
      return;
    }
    commitState({ status: 'loaded', runs: (first as any).runs ?? [] });
  }, [props.sessionId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  useFocusEffect(
    React.useCallback(() => {
      void load();
    }, [load]),
  );

  const headerRight = React.useCallback(() => {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {canShowLaunchButtons ? (
          <>
            {launchIntents.map((nextIntent) => {
              const iconName = nextIntent === 'review'
                ? 'search-outline'
                : nextIntent === 'plan'
                    ? 'list-outline'
                    : 'person-add-outline';
              return (
                <Pressable
                  key={nextIntent}
                  accessibilityRole="button"
                  accessibilityLabel={t(`executionRuns.newRun.intents.${nextIntent}`)}
                  onPress={() => {
                    if (!props.sessionId) return;
                    router.push(`/session/${props.sessionId}/runs/new?intent=${nextIntent}` as any);
                  }}
                  hitSlop={10}
                  style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.7 : 1 })}
                >
                  <Ionicons name={iconName as any} size={20} color={headerTint} />
                </Pressable>
              );
            })}
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
  }, [canShowLaunchButtons, headerTint, launchIntents, load, props.sessionId, router]);

  const screenOptions = React.useMemo(() => ({
    headerShown: true,
    headerTitle: t('runs.title'),
    headerRight,
  }), [headerRight]);

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
              router.push(`/session/${props.sessionId}/runs/${run.runId}` as any);
            }}
          />
        )}
      </ConstrainedScreenContent>
    </View>
  );
}

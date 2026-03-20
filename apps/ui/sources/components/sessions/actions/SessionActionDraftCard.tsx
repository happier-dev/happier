import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { getActionSpec, resolveEffectiveActionInputFields } from '@happier-dev/protocol';
import { useRouter } from 'expo-router';

import { storage, useSession } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useExecutionRunsBackendsForSession } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { t } from '@/text';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import { buildAvailableReviewEngineOptions } from '@/sync/domains/reviews/reviewEngineCatalog';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { resolveActionInputValidationError } from '@/sync/domains/actions/resolveActionInputValidationError';
import { ActionInputFields } from './ActionInputFields';


type EngineOption = Readonly<{ id: string; label: string; disabled?: boolean }>;

function useReviewEngineOptions(sessionId: string): readonly EngineOption[] {
  const enabledAgentIds = useEnabledAgentIds();
  const backends = useExecutionRunsBackendsForSession(sessionId);

  return React.useMemo(() => {
    const opts = buildAvailableReviewEngineOptions({
      enabledAgentIds,
      executionRunsBackends: backends,
      resolveAgentLabel: (id) => t(getAgentCore(id as AgentId).displayNameKey),
    });
    return opts;
  }, [backends, enabledAgentIds]);
}

function useExecutionBackendOptions(): readonly EngineOption[] {
  const enabledAgentIds = useEnabledAgentIds();
  return React.useMemo(
    () =>
      enabledAgentIds.map((id) => ({
        id,
        label: t(getAgentCore(id as AgentId).displayNameKey),
      })),
    [enabledAgentIds],
  );
}

export function SessionActionDraftCard(props: Readonly<{ sessionId: string; draft: SessionActionDraft }>) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const spec = getActionSpec(props.draft.actionId as any);
  const executor = React.useMemo(
    () => createDefaultActionExecutor({
      resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache,
      openSession: (sessionId) => {
        router.push((`/session/${sessionId}`) as any);
      },
    }),
    [router],
  );

  const input: Record<string, unknown> = props.draft.input ?? {};
  const engineOptions = useReviewEngineOptions(props.sessionId);
  const backendOptions = useExecutionBackendOptions();
  const submitInFlightRef = React.useRef(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const resolveFieldOptions = React.useCallback(
    (field: any): ReadonlyArray<Readonly<{ value: string; label: string; disabled?: boolean }>> => {
      const sourceId = typeof field?.optionsSourceId === 'string' ? field.optionsSourceId : '';
      if (sourceId === 'review.engines.available') {
        return engineOptions.map((o) => ({ value: o.id, label: o.label, ...(o.disabled ? { disabled: true } : {}) }));
      }
      if (sourceId === 'execution.backends.enabled') {
        return backendOptions.map((o) => ({ value: o.id, label: o.label }));
      }
      const opts = Array.isArray(field?.options) ? field.options : [];
      return opts
        .map((o: any) => {
          const value = typeof o?.value === 'string' ? o.value : '';
          const label = typeof o?.label === 'string' ? o.label : value;
          if (!value) return null;
          return { value, label };
        })
        .filter(Boolean) as any;
    },
    [backendOptions, engineOptions],
  );

  const setInputPatch = React.useCallback(
    (patch: Record<string, unknown>) => {
      storage.getState().updateSessionActionDraftInput(props.sessionId, props.draft.id, patch);
      storage.getState().setSessionActionDraftStatus(props.sessionId, props.draft.id, 'editing', null);
    },
    [props.draft.id, props.sessionId],
  );

  const setStatus = React.useCallback(
    (status: 'editing' | 'running' | 'succeeded' | 'failed', error?: string | null) => {
      storage.getState().setSessionActionDraftStatus(props.sessionId, props.draft.id, status as any, error);
    },
    [props.draft.id, props.sessionId],
  );

  const cancel = React.useCallback(() => {
    storage.getState().deleteSessionActionDraft(props.sessionId, props.draft.id);
  }, [props.draft.id, props.sessionId]);

  const fields = React.useMemo(() => {
    return resolveEffectiveActionInputFields(spec as any, { sessionId: props.sessionId, ...(props.draft.input ?? {}) });
  }, [props.draft.input, props.sessionId, spec]);

  const validationError = React.useMemo(
    () => resolveActionInputValidationError({
      sessionId: props.sessionId,
      input,
      spec: spec as any,
      fields: fields as any,
    }),
    [fields, input, props.sessionId, spec],
  );

  const submit = React.useCallback(async () => {
    if (submitInFlightRef.current) return;
    const err = validationError;
    if (err) {
      setStatus('editing', err);
      return;
    }

    submitInFlightRef.current = true;
    setIsSubmitting(true);
    setStatus('running', null);
    try {
      const res = await executor.execute(
        props.draft.actionId as any,
        {
          sessionId: props.sessionId,
          ...(props.draft.input ?? {}),
        },
        { defaultSessionId: props.sessionId, surface: 'ui_button', placement: 'session_action_menu' } as any,
      );
      const errorMessage = resolveActionExecutionFailureMessage(res, 'Failed to start');
      if (errorMessage) {
        setStatus('editing', errorMessage);
        return;
      }
      setStatus('succeeded', null);
      // Action drafts are ephemeral UI affordances. Once the action has been dispatched
      // successfully, remove the draft card so the transcript doesn't stay cluttered.
      cancel();
    } catch (e) {
      setStatus('editing', e instanceof Error ? e.message : 'Failed to start');
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
    }
  }, [cancel, executor, props.draft.actionId, props.draft.input, props.sessionId, setStatus, validationError]);

  const title = spec.title;
  const error = validationError ?? (props.draft.error ? String(props.draft.error) : '');
  const startDisabled = props.draft.status === 'running' || isSubmitting || validationError !== null;

  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
      <View style={{ width: '100%', alignSelf: 'center', flexDirection: 'column', flexGrow: 1, flexBasis: 0, maxWidth: layout.maxWidth }}>
        <View style={{ marginHorizontal: 16 }}>
          <View
            style={{
              marginVertical: 8,
              padding: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: theme.colors.divider,
              backgroundColor: theme.colors.surface,
            }}
          >
            <Text style={{ color: theme.colors.text, fontWeight: '600', marginBottom: 8 }}>{title}</Text>

            {fields.length > 0 ? (
              <ActionInputFields
                fields={fields as any}
                input={input}
                editable={props.draft.status !== 'running' && !isSubmitting}
                resolveFieldOptions={(field) => resolveFieldOptions(field as any)}
                onPatch={setInputPatch}
              />
            ) : (
            <Text style={{ color: theme.colors.textSecondary }}>{t('session.actionsDraft.noInputHints')}</Text>
          )}

          {error ? (
            <Text style={{ color: theme.colors.status.error, marginTop: 10 }}>{error}</Text>
          ) : null}

          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
            <Pressable
              accessibilityRole="button"
              onPress={cancel}
              disabled={props.draft.status === 'running' || isSubmitting}
              style={({ pressed }) => ({
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 10,
                opacity: props.draft.status === 'running' || isSubmitting ? 0.4 : pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ color: theme.colors.textSecondary }}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => void submit()}
              disabled={startDisabled}
              style={({ pressed }) => ({
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 10,
                backgroundColor: theme.colors.button.primary.background,
                opacity: startDisabled ? 0.5 : pressed ? 0.8 : 1,
              })}
            >
              <Text style={{ color: theme.colors.button.primary.tint, fontWeight: '600' }}>{t('common.start')}</Text>
            </Pressable>
          </View>
          </View>
        </View>
      </View>
    </View>
  );
}

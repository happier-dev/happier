import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { getActionSpec } from '@happier-dev/protocol';

import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { storage } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { t } from '@/text';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { ActionInputFields } from './ActionInputFields';
import { resolveSessionActionDraftHeightBearingPaint } from './sessionActionDraftPresentation';
import { useSessionActionFieldOptions } from './useSessionActionFieldOptions';


export function SessionActionDraftCard(props: Readonly<{ sessionId: string; draft: SessionActionDraft }>) {
  const { theme } = useUnistyles();
  const navigateToSession = useNavigateToSession();
  const spec = getActionSpec(props.draft.actionId as any);
  const executor = React.useMemo(
    () => createDefaultActionExecutor({
      resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache,
      openSession: (sessionId) => navigateToSession(sessionId),
    }),
    [navigateToSession],
  );

  const input: Record<string, unknown> = props.draft.input ?? {};
  // ONE option resolution, consumed by the chips this card paints AND by the height-bearing
  // descriptor the transcript row's size key is built from (F-4).
  const resolveFieldOptions = useSessionActionFieldOptions(props.sessionId);
  const submitInFlightRef = React.useRef(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

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

  // The row's height-bearing paint is resolved by its painter and consumed by BOTH this card and
  // `transcriptRowShellSignature` (F-P6), so the size key can never disagree with what is rendered.
  const paint = React.useMemo(
    () => resolveSessionActionDraftHeightBearingPaint({
      draft: { actionId: props.draft.actionId, input: props.draft.input ?? {}, error: props.draft.error },
      sessionId: props.sessionId,
      resolveFieldOptions,
    }),
    [props.draft.actionId, props.draft.error, props.draft.input, props.sessionId, resolveFieldOptions],
  );
  const fields = React.useMemo(() => paint.fields.map((entry) => entry.field), [paint]);
  // V-4: the descriptor resolves the in-flow notice, so the transcript row's size key and this card
  // paint the same line. The card must not re-derive it.
  const validationError = paint.validationError;

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
  const error = paint.errorLine;
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
              borderColor: theme.colors.border.default,
              backgroundColor: theme.colors.surface.base,
            }}
          >
            <Text style={{ color: theme.colors.text.primary, fontWeight: '600', marginBottom: 8 }}>{title}</Text>

            {fields.length > 0 ? (
              <ActionInputFields
                fields={fields as any}
                input={input}
                editable={props.draft.status !== 'running' && !isSubmitting}
                resolveFieldOptions={resolveFieldOptions}
                onPatch={setInputPatch}
              />
            ) : (
            <Text style={{ color: theme.colors.text.secondary }}>{t('session.actionsDraft.noInputHints')}</Text>
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
              <Text style={{ color: theme.colors.text.secondary }}>{t('common.cancel')}</Text>
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

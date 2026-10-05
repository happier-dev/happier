import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { getActionSpec } from '@happier-dev/protocol';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { storage } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { t } from '@/text';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { ActionInputFields } from './ActionInputFields';
import { resolveSessionActionDraftHeightBearingPaint } from './sessionActionDraftPresentation';
import { useSessionActionFieldOptions } from './useSessionActionFieldOptions';
import { normalizeActionInput, normalizeActionInputPatch } from '@/sync/domains/actions/normalizeActionInputPatch';
import { motionTokens } from '@/components/ui/motion/motionTokens';


export function SessionActionDraftCard(props: Readonly<{ draft: SessionActionDraft }>) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const sessionServerId = props.draft.address.serverId;
  const sessionId = props.draft.address.sessionId;
  const spec = getActionSpec(props.draft.actionId as any);
  const executor = React.useMemo(
    () => createDefaultActionExecutor({
      resolveServerIdForSessionId: () => sessionServerId,
      openSession: (sessionId, options) => {
        router.push(buildScopedSessionRouteHref({
          sessionId,
          serverId: options?.serverId ?? sessionServerId,
          query: options?.query,
        }) as any);
      },
    }),
    [router, sessionServerId],
  );

  const input: Record<string, unknown> = props.draft.input ?? {};
  // F-4 (2026-08-11): ONE owner for "which options does this field show". This card used to resolve
  // it inline; the transcript row's size key now needs the same answer for an OFFSCREEN row, and two
  // implementations of it would be exactly the drift the height-bearing descriptor exists to prevent.
  const resolveSessionFieldOptions = useSessionActionFieldOptions(sessionId, sessionServerId);
  const resolveFieldOptions = React.useMemo(() => {
    const context = { actionId: props.draft.actionId, draftInput: input };
    const resolveState = resolveSessionFieldOptions.state;
    return Object.assign(
      (field: Parameters<typeof resolveSessionFieldOptions>[0]) => resolveSessionFieldOptions(field, context),
      { state: resolveState ? (field: Parameters<typeof resolveState>[0]) => resolveState(field, context) : undefined,
        retry: resolveSessionFieldOptions.retry,
        pickerContext: resolveSessionFieldOptions.pickerContext },
    );
  }, [resolveSessionFieldOptions, props.draft.actionId, input]);
  const submitInFlightRef = React.useRef(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const draftScope = React.useMemo(() => ({
    serverId: props.draft.address.serverId,
    accountId: props.draft.accountId,
  }), [props.draft.accountId, props.draft.address.serverId]);

  const setInputPatch = React.useCallback(
    (patch: Record<string, unknown>) => {
      const normalizedPatch = normalizeActionInputPatch({ actionId: props.draft.actionId, patch });
      storage.getState().updateSessionActionDraftInput(draftScope, props.draft.address, props.draft.id, normalizedPatch);
      storage.getState().setSessionActionDraftStatus(draftScope, props.draft.address, props.draft.id, 'editing', null);
    },
    [draftScope, props.draft.actionId, props.draft.address, props.draft.id],
  );

  const setStatus = React.useCallback(
    (status: 'editing' | 'running' | 'succeeded' | 'failed', error?: string | null) => {
      storage.getState().setSessionActionDraftStatus(draftScope, props.draft.address, props.draft.id, status as any, error);
    },
    [draftScope, props.draft.address, props.draft.id],
  );

  const cancel = React.useCallback(() => {
    storage.getState().deleteSessionActionDraft(draftScope, props.draft.address, props.draft.id);
  }, [draftScope, props.draft.address, props.draft.id]);

  // The row's height-bearing paint is resolved by its painter and consumed by BOTH this card and
  // `transcriptRowShellSignature` (F-P6), so the size key can never disagree with what is rendered.
  const paint = React.useMemo(
    () => resolveSessionActionDraftHeightBearingPaint({
      draft: { actionId: props.draft.actionId, input: props.draft.input ?? {}, error: props.draft.error },
      sessionId,
      resolveFieldOptions,
    }),
    [props.draft.actionId, props.draft.error, props.draft.input, sessionId, resolveFieldOptions],
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
      const normalizedInput = normalizeActionInput({
        actionId: props.draft.actionId,
        input: props.draft.input ?? {},
      });
      const res = await executor.execute(
        props.draft.actionId as any,
        {
          sessionId,
          ...normalizedInput,
        },
        { defaultSessionId: sessionId, surface: 'ui', placement: 'session_action_menu' } as any,
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
  }, [cancel, executor, props.draft.actionId, props.draft.input, sessionId, setStatus, validationError]);

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
                opacity: props.draft.status === 'running' || isSubmitting ? 0.4 : pressed ? motionTokens.press.opacity : 1,
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
                opacity: startDisabled ? 0.5 : pressed ? motionTokens.press.opacitySubtle : 1,
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

import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { useVoiceDictation } from './useVoiceDictation';
import { resolveVoiceDictationFailureTranslationKey, resolveVoiceDictationStartErrorTranslationKey } from './voiceDictationErrorCopy';
import { useCurrentUiContextMountPublisher, useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { executeMountedCurrentUiContextCommand } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { isActionApprovalDeclinedErrorCode, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { resolveActionSurfaceAvailability } from '@happier-dev/protocol/actions/actionSurfaceAvailability';
import { useSettingsSelector } from '@/sync/store/settingsReadHooks';
import type { CurrentUiContextMountedEnrichment } from '@/components/appShell/currentUiContext/currentUiContextModel';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { checkMicrophonePermission } from '@/utils/platform/microphonePermissions';
import { VoiceDictationActionResultSchema, VoiceSetupMicrophonePermissionActionResultSchema,
    type VoiceDictationActionResult, type VoiceDictationOperation } from '@happier-dev/protocol/actions/voiceConversationActionFamily';

export type TextInputDictation = Readonly<{
    status: ReturnType<typeof useVoiceDictation>['status'];
    available: boolean;
    onPress(): Promise<void>;
    /** The real field/button focus lends its exact target to current-UI Actions. */
    onFocus(): Promise<boolean>;
}>;

/** Shared composer/author-input delivery adapter; capture, engine, language and permission stay canonical. */
export function useTextInputDictation(input: Readonly<{
    controlId: string;
    enabled: boolean;
    presented: boolean;
    editable: boolean;
    transcriptionSessionId: string | null;
    onTranscription(text: string): void;
}>): TextInputDictation {
    const authorityRef = React.useRef(input);
    authorityRef.current = input;
    React.useEffect(() => () => {
        if (authorityRef.current.controlId !== input.controlId) return;
        authorityRef.current = { ...authorityRef.current, controlId: '', enabled: false, presented: false, editable: false };
    }, [input.controlId]);
    const dictation = useVoiceDictation(input.controlId || undefined, input.presented && input.enabled, input.editable, input.transcriptionSessionId);
    const available = useSettingsSelector(settings => resolveActionSurfaceAvailability({
        actionId: dictation.status === 'listening' ? 'ui.voice_global.dictation.finish' : 'ui.voice_global.dictation.start',
        surface: 'ui', settings: settings.actionsSettingsV1,
    }).available, ['actionsSettingsV1']);
    const dictationRef = React.useRef(dictation);
    dictationRef.current = dictation;
    // Keep the mounted field's detailed capture feedback local; public Actions
    // return the existing structural failure codes.
    const captureErrorRef = React.useRef<unknown>(null);
    const publisher = useCurrentUiContextMountPublisher();
    const reader = useOptionalCurrentUiContextReader();
    const execute = React.useMemo(() => createFrontDoorActionExecute(), []);
    const mount = React.useMemo(() => publisher?.createMount() ?? null, [publisher, input.controlId]);
    const focus = React.useRef<Readonly<{ account: ActiveServerAccountScopeLifetime; enrichment: CurrentUiContextMountedEnrichment; dispose(): void }> | null>(null);
    React.useEffect(() => () => {
        focus.current?.dispose(); focus.current = null;
        mount?.dispose();
    }, [mount]);
    React.useEffect(() => {
        if (input.enabled && input.presented && input.editable) return;
        focus.current?.dispose(); focus.current = null;
        mount?.clear();
    }, [input.enabled, input.presented, input.editable, mount]);

    const toggleAndInsert = React.useCallback(async (isCurrent: () => boolean = () => true) => {
        const result = await dictation.toggle();
        const owner = authorityRef.current;
        const inserted = result.kind === 'completed' && Boolean(result.text)
            && owner.controlId === input.controlId && owner.enabled && owner.presented && owner.editable && isCurrent();
        if (inserted && result.kind === 'completed' && result.text) owner.onTranscription(result.text);
        return { result, inserted };
    }, [dictation.toggle, input.controlId]);
    const deliveryRef = React.useRef(toggleAndInsert);
    deliveryRef.current = toggleAndInsert;

    const onFocus = React.useCallback(async (): Promise<boolean> => {
        const field = authorityRef.current;
        const account = captureActiveServerAccountScopeLifetime();
        if (!mount || !account || !field.controlId || !field.enabled || !field.presented || !field.editable) return false;
        if (focus.current?.account !== account) {
            focus.current?.dispose();
            const key = input.controlId;
            const invoke = async (operation: VoiceDictationOperation, signal: AbortSignal): Promise<VoiceDictationActionResult> => {
                captureErrorRef.current = null;
                const unavailable = (code: Extract<VoiceDictationActionResult, { status: 'unavailable' }>['code']): VoiceDictationActionResult => ({ status: 'unavailable', code });
                const current = () => account.isCurrent() && !signal.aborted && authorityRef.current.controlId === key
                    && authorityRef.current.enabled && authorityRef.current.presented && authorityRef.current.editable;
                if (!current()) return unavailable('dictation_field_unavailable');
                const controller = dictationRef.current;
                if (operation === 'cancel') { await controller.cancel(); return { status: 'completed', dictationStatus: 'idle', inserted: false }; }
                if (operation === 'dismiss') {
                    const failure = controller.getSnapshot().failure;
                    if (failure) controller.dismissFailure(failure.id);
                    return { status: 'completed', dictationStatus: controller.getSnapshot().status, inserted: false };
                }
                if (operation === 'start') {
                    const permission = await checkMicrophonePermission();
                    if (!current()) return unavailable('dictation_field_unavailable');
                    if (!permission.granted) return unavailable(permission.unavailable ? 'dictation_microphone_unavailable' : 'dictation_consent_required');
                }
                // Never let an explicit Start become toggle's Finish (or Finish acquire a mic).
                const before = controller.getSnapshot();
                if (operation === 'start' ? before.status !== 'idle' : before.status !== 'listening') return unavailable('dictation_state_changed');
                const cancel = () => { void controller.cancel(); };
                signal.addEventListener('abort', cancel, { once: true });
                try {
                    const delivery = await deliveryRef.current(current);
                    if (!current() || delivery.result.kind === 'cancelled') return unavailable('dictation_cancelled');
                    return { status: 'completed', dictationStatus: controller.getSnapshot().status, inserted: delivery.inserted };
                } catch (error) {
                    captureErrorRef.current = error;
                    if (error instanceof Error && error.message === 'mic_permission_denied') return unavailable('dictation_consent_required');
                    if (error instanceof Error && error.message === 'mic_unavailable') return unavailable('dictation_microphone_unavailable');
                    return unavailable(resolveVoiceDictationStartErrorTranslationKey(error) ? 'dictation_capture_unavailable' : 'dictation_failed');
                } finally { signal.removeEventListener('abort', cancel); }
            };
            const cancelFocusedDictation = dictationRef.current.cancel;
            const retirement = account.onRetire(() => { mount.clear(); void cancelFocusedDictation(); });
            focus.current = { account, dispose: () => retirement.dispose(), enrichment: {
                commands: (['start', 'finish', 'cancel', 'dismiss'] as const).map(operation => ({
                    title: t(operation === 'start' ? 'voiceAssistant.startDictation' : operation === 'finish' ? 'voiceAssistant.endDictation'
                        : operation === 'cancel' ? 'common.cancel' : 'common.close'),
                    command: { kind: 'voiceDictation', operation, account, invoke: ({ signal }) => invoke(operation, signal) },
                })),
            } };
        }
        return mount.activateCurrent(focus.current.enrichment);
    }, [input.controlId, mount]);

    const invokeAction = React.useCallback(async (operation: VoiceDictationOperation): Promise<ActionExecuteResult> => {
        if (!await onFocus()) return { ok: true, result: { status: 'unavailable', code: 'dictation_field_unavailable' } };
        const focused = focus.current;
        const command = focused?.enrichment.commands?.find(entry => entry.command.kind === 'voiceDictation'
            && entry.command.operation === operation)?.command;
        return executeMountedCurrentUiContextCommand({ reader, command,
            execute: (actionId, args) => execute(actionId, args, { surface: 'ui', authority: 'present_user',
                serverId: focused?.account.scope.serverId, expectedAccountId: focused?.account.scope.accountId }),
        });
    }, [execute, onFocus, reader]);
    React.useEffect(() => {
        if (!dictation.failure) return;
        if (dictation.failure.kind !== 'mic_permission_denied') {
            Modal.alert(t('common.error'), t(resolveVoiceDictationFailureTranslationKey(dictation.failure.reason)));
        }
        dictation.dismissFailure(dictation.failure.id);
    }, [dictation.dismissFailure, dictation.failure]);

    const onPress = React.useCallback(async () => {
        const current = authorityRef.current;
        if (!current.enabled || !current.presented || !current.editable || !input.controlId) return;
        const admittedKey = input.controlId;
        const status = dictationRef.current.getSnapshot().status;
        if (status !== 'idle' && status !== 'listening') return;
        const operation = status === 'listening' ? 'finish' : 'start';
        const actionId = operation === 'start' ? 'ui.voice_global.dictation.start' : 'ui.voice_global.dictation.finish';
        try {
            let outcome = await invokeAction(operation);
            if (!outcome.ok && presentActionTurnedOffNoticeIfOff(outcome, actionId)) return;
            if (!outcome.ok && isActionApprovalDeclinedErrorCode(outcome.errorCode)) return;
            requireActionSuccess(outcome);
            let result = VoiceDictationActionResultSchema.parse(outcome.result);
            if (operation === 'start' && result.status === 'unavailable' && result.code === 'dictation_consent_required') {
                const account = focus.current?.account;
                const permissionAction = 'ui.voice_global.setup.microphone.permission.request';
                const permissionOutcome = await execute(permissionAction, {}, { surface: 'ui', authority: 'present_user',
                    serverId: account?.scope.serverId, expectedAccountId: account?.scope.accountId });
                if (!permissionOutcome.ok && presentActionTurnedOffNoticeIfOff(permissionOutcome, permissionAction)) return;
                requireActionSuccess(permissionOutcome);
                if (VoiceSetupMicrophonePermissionActionResultSchema.parse(permissionOutcome.result).status !== 'completed') return;
                outcome = await invokeAction('start');
                if (!outcome.ok && presentActionTurnedOffNoticeIfOff(outcome, actionId)) return;
                requireActionSuccess(outcome);
                result = VoiceDictationActionResultSchema.parse(outcome.result);
            }
            const owner = authorityRef.current;
            if (owner.controlId !== admittedKey || !owner.enabled || !owner.presented || !owner.editable) return;
            if (result.status === 'unavailable') {
                if (result.code === 'dictation_failed' || result.code === 'dictation_microphone_unavailable' || result.code === 'dictation_capture_unavailable') {
                    Modal.alert(t('common.error'), t(resolveVoiceDictationStartErrorTranslationKey(captureErrorRef.current) ?? 'errors.dictationFailed'));
                }
                return;
            }
            if (operation === 'finish' && !result.inserted && !dictationRef.current.getSnapshot().failure) {
                Modal.alert(t('voiceAssistant.dictationNoSpeech'));
                return;
            }
        } catch (error) {
            if (error instanceof Error && error.message === 'mic_permission_denied') return;
            const key = resolveVoiceDictationStartErrorTranslationKey(error);
            Modal.alert(t('common.error'), t(key ?? 'errors.dictationFailed'));
        }
    }, [execute, invokeAction, input.controlId]);
    return { status: dictation.status, available, onPress, onFocus };
}

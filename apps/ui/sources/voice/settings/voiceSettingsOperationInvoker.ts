import { Platform } from 'react-native';
import { primeWebAudioPlayback } from '@/voice/output/webAudioContext';
import { HAPPIER_PRIVACY_POLICY_URL } from '@/constants/legalUrls';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { getDefaultModelPackId, resolveCanonicalModelPackId } from '@happier-dev/protocol/voice/modelPacks/catalog';
import type { SettingOperationContext, SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { Modal } from '@/modal';
import type { Settings } from '@/sync/domains/settings/settings';
import { readLocalConversationVoiceSettings, readLocalDirectVoiceSettings, readVoiceDiagnosticsSettings, voiceSettingsParse, writeVoiceDiagnosticsSettings } from '@/sync/domains/settings/voiceSettings';
import { storage } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { resolveVoiceExecutionMachinePresentationFromState } from '@/voice/credentials/useExecutionMachinePresentation';
import { t, tLoose } from '@/text';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { resolveLocalVoiceAdapterSettings, parseLocalVoiceSttSettings, parseLocalVoiceTtsSettings } from '@/voice/local/localVoiceSettings';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import { createVoiceDictationRuntimeSettingsSnapshot } from '@/voice/dictation/voiceDictationRuntimeSettings';
import { createVoiceDiagnosticsClientForMachine } from '@/voice/diagnostics/client';
import { applyVoiceDiagnosticsMachinePolicy, retryVoiceDiagnosticsRevocation, revokeVoiceDiagnosticsSessionAuthorization } from '@/voice/diagnostics/runtimeRevocation';
import { readVoiceDiagnosticsRuntimeStatus } from '@/voice/diagnostics/runtimeStatus';
import { resolveVoiceDiagnosticsCaptureAuthorizationId } from '@/voice/diagnostics/capturePolicy';
import { resolveVoiceExecutionMachineId } from './executionMachine';
import { updateVoiceLocalConversationSetting } from './voiceSettingBinding';
import { buildModelCatalogRows } from './panels/modelCatalog/buildModelCatalogRows';
import { invokeDaemonModelPackOperation } from './panels/modelCatalog/invokeDaemonModelPackOperation';
import { projectVoiceProcessingDisclosures } from './projectVoiceProcessingDisclosures';
import { inspectVoiceSettingsSemanticReadiness } from './voiceProviderReadinessInspection';
import type { VoiceSettingsOperation } from './voiceSettingsOperation';
import { captureVoiceModelCancellation } from './voiceModelCancellation';
import { captureDaemonVoiceModelCatalogObservation } from './panels/modelCatalog/daemonVoiceModelCatalogObservation';

const unavailable = (reason: string): SettingOperationResult => ({ status: 'unavailable', reason });
const completed = (value?: unknown): SettingOperationResult => ({ status: 'completed', ...(value === undefined ? {} : { value: StrictJsonValueSchema.parse(value) }) });

/** Actions adapt the existing operation owners. They never infer success from opening a row. */
export async function invokeVoiceSettingsOperation(operation: VoiceSettingsOperation, purpose: 'conversation' | 'dictation', context: SettingOperationContext): Promise<SettingOperationResult> {
    const input = context.input;
    const cancelsModel = operation === 'model_cancel' || operation === 'stt_cancel' || operation === 'tts_cancel';
    if (['model_install', 'model_remove', 'model_default'].includes(operation) && input?.kind !== 'model_pack'
        || cancelsModel && input?.kind !== 'model_pack'
        || operation === 'diagnostics_export' && input?.kind !== 'diagnostics_export'
        || operation === 'diagnostics_session_opt_out' && input?.kind !== 'diagnostics_session'
        || operation === 'diagnostics_retry_shutdown' && input?.kind !== 'diagnostics_revocation'
        || operation === 'diagnostics_enabled' && input?.kind !== 'diagnostics_enabled') return unavailable('operation_input_required');
    const acceptsModel = cancelsModel || ['model_install', 'model_remove', 'model_default', 'stt_prepare', 'stt_remove', 'stt_update', 'tts_prepare', 'tts_remove', 'tts_update'].includes(operation);
    if (input && !(acceptsModel && input.kind === 'model_pack'
        || operation === 'tts_preview' && input.kind === 'voice_preview'
        || operation === 'diagnostics_export' && input.kind === 'diagnostics_export'
        || operation === 'diagnostics_session_opt_out' && input.kind === 'diagnostics_session'
        || operation === 'diagnostics_retry_shutdown' && input.kind === 'diagnostics_revocation'
        || operation === 'diagnostics_enabled' && input.kind === 'diagnostics_enabled')) return unavailable('operation_input_invalid');
    const modelPresentation = context.services?.voiceModelPackPresentation;
    const current = () => !context.signal?.aborted && context.isCurrent() && (modelPresentation?.isCurrent() ?? true);
    if (!current()) return { status: 'cancelled' };
    const cancellation = cancelsModel && input?.kind === 'model_pack'
        ? captureVoiceModelCancellation(resolveCanonicalModelPackId(input.packId)) : null;
    if (cancelsModel && (!cancellation || !areServerAccountScopesEqual(context.accountScope, cancellation.target.account.scope))) {
        return unavailable('model_operation_changed');
    }
    try {
        if (operation === 'history_inspect') {
            const { getDefaultVoiceHistoryConsumer } = await import('@/voice/history/defaultVoiceHistoryConsumer');
            if (!current()) return { status: 'cancelled' };
            const history = await getDefaultVoiceHistoryConsumer().search();
            return current() ? completed(history) : { status: 'cancelled' };
        }
        if (operation === 'privacy_policy_open') {
            const { openExternalUrl } = await import('@/utils/url/openExternalUrl');
            if (!current()) return { status: 'cancelled' };
            const opened = await openExternalUrl(HAPPIER_PRIVACY_POLICY_URL);
            if (!current()) return { status: 'cancelled' };
            return opened ? completed() : unavailable('external_url_open_failed');
        }
        const settings = await context.readSettings();
        throwIfAborted(context.signal);
        if (!current()) return { status: 'cancelled' };
        const voice = voiceSettingsParse(settings.voice);
        const machineId = resolveVoiceExecutionMachineId();
        const material = (latest: Settings) => {
            if (operation !== 'readiness_inspect') return JSON.stringify(latest.voice);
            const machine = resolveVoiceExecutionMachinePresentationFromState(storage.getState());
            return JSON.stringify({ voice: latest.voice, backendEnabledByTargetKey: latest.backendEnabledByTargetKey,
                featureToggles: latest.featureToggles, experiments: latest.experiments, secrets: latest.secrets,
                executionMachine: { machineId: machine.machineId, selectedMachineId: machine.selectedMachineId, selectionKind: machine.selectionKind } });
        };
        const capturedMaterial = material(settings);
        const selectionCurrent = () => current() && resolveVoiceExecutionMachineId() === machineId;
        const operationCurrent = async () => {
            if (!selectionCurrent()) return false;
            const latest = await context.readSettings();
            return selectionCurrent() && material(latest) === capturedMaterial;
        };
        if (input && 'machineId' in input && input.machineId && input.machineId !== machineId) return unavailable('execution_machine_changed');

        if (operation === 'tts_preview_stop') {
            const { localNeuralTtsPreviewController } = await import('./panels/localTts/providers/localNeural/previewLocalNeuralTts');
            if (!current()) return { status: 'cancelled' };
            return completed({ stopped: localNeuralTtsPreviewController.stop() });
        }

        if (operation === 'memory_forget') {
            const confirmed = await Modal.confirm(t('settingsVoice.local.conversation.resetVoiceAgent.title'),
                t('settingsVoice.local.conversation.resetVoiceAgent.confirmBody'), { confirmText: t('common.reset') });
            if (!confirmed || !await operationCurrent()) return { status: 'cancelled' };
            const { resetGlobalVoiceAgentPersistence } = await import('@/voice/agent/resetGlobalVoiceAgentPersistence');
            if (!await operationCurrent()) return { status: 'cancelled' };
            await resetGlobalVoiceAgentPersistence();
            return selectionCurrent() ? completed() : { status: 'cancelled' };
        }
        const diagnostics = readVoiceDiagnosticsSettings(voice);
        if (operation === 'diagnostics_enabled' && input?.kind === 'diagnostics_enabled') {
            if (input.enabled) {
                const confirmed = await Modal.confirm(tLoose('settingsVoice.diagnostics.consentTitle'),
                    tLoose('settingsVoice.diagnostics.consentBody'), { confirmText: tLoose('settingsVoice.diagnostics.consentAction') });
                if (!confirmed || !await operationCurrent()) return { status: 'cancelled' };
            }
            await context.mutateSettings(latest => {
                if (!selectionCurrent() || material(latest) !== capturedMaterial) return null;
                const before = readVoiceDiagnosticsSettings(latest.voice);
                return { voice: writeVoiceDiagnosticsSettings(latest.voice, { ...before, enabled: input.enabled,
                    consentVersion: input.enabled ? 1 : null,
                    captureSttInput: input.enabled ? before.captureSttInput || !before.captureTtsOutput : before.captureSttInput }) };
            });
            // Runtime sync remains the sole desired-versus-actual policy writer.
            return selectionCurrent() ? completed({ enabled: input.enabled }) : { status: 'cancelled' };
        }
        if (operation === 'diagnostics_retry_shutdown' && input?.kind === 'diagnostics_revocation') {
            const obligation = readVoiceDiagnosticsRuntimeStatus().revocationObligations.find(candidate => candidate.key === input.key && candidate.revision === input.revision);
            if (!obligation) return unavailable('revocation_obligation_changed');
            const { storage } = await import('@/sync/domains/state/storage');
            if (!await operationCurrent()) return { status: 'cancelled' };
            const scope = storage.getState().settingsScope;
            const result = await retryVoiceDiagnosticsRevocation({ obligation, settings: diagnostics,
                persistenceScope: scope ? { serverId: scope.serverId, accountId: scope.accountId } : null, signal: context.signal });
            if (!await operationCurrent()) return { status: 'cancelled' };
            if (!result.ok) return unavailable('diagnostics_shutdown_failed');
            return result.acknowledged ? completed() : unavailable('diagnostics_shutdown_unacknowledged');
        }
        if (operation === 'diagnostics_session_opt_out' && input?.kind === 'diagnostics_session') {
            const runtime = readVoiceDiagnosticsRuntimeStatus();
            if (runtime.machineId !== input.machineId || runtime.phase === 'inactive_confirmed') return unavailable('diagnostics_session_unavailable');
            const { getVoiceSessionSnapshot, getVoiceSessionAttemptId } = await import('@/voice/session/voiceSessionStore');
            const attempt = getVoiceSessionSnapshot();
            const attemptId = getVoiceSessionAttemptId();
            if (attempt.sessionId !== input.sessionId || !attempt.canStop) return unavailable('diagnostics_session_unavailable');
            const confirmed = await Modal.confirm(tLoose('settingsVoice.diagnostics.sessionOptOutConfirmTitle'),
                tLoose('settingsVoice.diagnostics.sessionOptOutConfirmBody'), { confirmText: tLoose('settingsVoice.diagnostics.sessionOptOut') });
            if (!confirmed || !await operationCurrent() || getVoiceSessionAttemptId() !== attemptId || getVoiceSessionSnapshot().sessionId !== attempt.sessionId) return { status: 'cancelled' };
            const result = await revokeVoiceDiagnosticsSessionAuthorization({ machineId: input.machineId, sessionId: input.sessionId,
                authorizationId: resolveVoiceDiagnosticsCaptureAuthorizationId(input.sessionId), signal: context.signal });
            if (!await operationCurrent()) return { status: 'cancelled' };
            return result.ok && result.acknowledged ? completed() : unavailable('diagnostics_session_opt_out_failed');
        }
        if (operation === 'diagnostics_inspect') {
            const daemonStatus = machineId ? await createVoiceDiagnosticsClientForMachine(machineId).status(context.signal) : null;
            if (!await operationCurrent()) return { status: 'cancelled' };
            return completed({ daemonStatus, clientRuntime: readVoiceDiagnosticsRuntimeStatus(),
                processingDisclosures: projectVoiceProcessingDisclosures(voice) });
        }
        if (operation.startsWith('diagnostics_')) {
            if (!machineId) return unavailable('execution_machine_unavailable');
            const client = createVoiceDiagnosticsClientForMachine(machineId);
            if (operation === 'diagnostics_cleanup') {
                const result = await applyVoiceDiagnosticsMachinePolicy({ machineId, settings: diagnostics, signal: context.signal });
                if (!await operationCurrent()) return { status: 'cancelled' };
                return result.applied && result.acknowledged ? completed(result.status) : unavailable('diagnostics_cleanup_unacknowledged');
            }
            if (operation === 'diagnostics_delete') {
                const confirmed = await Modal.confirm(tLoose('settingsVoice.diagnostics.deleteConfirmTitle'),
                    tLoose('settingsVoice.diagnostics.deleteConfirmBody'), { confirmText: tLoose('settingsVoice.diagnostics.deleteAction'), destructive: true });
                if (!confirmed || !await operationCurrent()) return { status: 'cancelled' };
                await client.deleteAll(context.signal);
                return await operationCurrent() ? completed() : { status: 'cancelled' };
            }
            if (operation === 'diagnostics_export' && input?.kind === 'diagnostics_export') {
                const status = await client.status(context.signal);
                const artifact = status.artifacts.find(candidate => candidate.id === input.artifactId);
                if (!artifact) return unavailable('diagnostics_artifact_not_found');
                const { exportVoiceDiagnosticArtifact } = await import('@/voice/diagnostics/exportDiagnosticArtifact');
                if (!await operationCurrent()) return { status: 'cancelled' };
                return { status: await exportVoiceDiagnosticArtifact({ client, artifact, signal: context.signal, isCurrent: operationCurrent }) };
            }
        }

        const runtimeSettings = purpose === 'dictation' ? { ...settings, voice: voiceSettingsParse(createVoiceDictationRuntimeSettingsSnapshot(settings).voice) } : settings;
        const adapterId = resolveLocalVoiceAdapterSettings(runtimeSettings).adapterId;
        const cfg = adapterId === 'local_direct' ? readLocalDirectVoiceSettings(runtimeSettings.voice) : readLocalConversationVoiceSettings(runtimeSettings.voice);
        const stt = parseLocalVoiceSttSettings(cfg.stt);
        const tts = parseLocalVoiceTtsSettings(cfg.tts);
        if (operation === 'tts_catalog' || operation === 'tts_catalog_retry') {
            if (voice.providerId !== 'local_direct' && voice.providerId !== 'local_conversation') return unavailable('local_voice_service_not_selected');
            if (tts.provider !== 'local_neural') return unavailable('local_neural_engine_not_selected');
            const { readLocalNeuralVoiceCatalog } = await import('@/voice/kokoro/assets/readLocalNeuralVoiceCatalog');
            const { projectVoiceSettingsCatalogList } = await import('./panels/realtime/voiceCatalog');
            const catalog = await readLocalNeuralVoiceCatalog({ config: tts.localNeural,
                originMachineId: machineId, signal: context.signal });
            return await operationCurrent() ? completed({ rows: projectVoiceSettingsCatalogList(catalog.rows, true) }) : { status: 'cancelled' };
        }
        if (operation === 'tts_test' || operation === 'tts_preview') {
            if (voice.providerId !== 'local_direct' && voice.providerId !== 'local_conversation') return unavailable('local_voice_service_not_selected');
            if (Platform.OS === 'web' && typeof navigator !== 'undefined' && !navigator.userActivation?.isActive) return unavailable('audio_user_gesture_required');
            const { getLocalTtsProviderSpec } = await import('./panels/localTts/providers/registry');
            const spec = getLocalTtsProviderSpec(tts.provider);
            if (!spec) return unavailable('voice_tts_provider_unavailable');
            if (operation === 'tts_preview' && tts.provider !== 'local_neural') return unavailable('voice_preview_unavailable');
            const previewTts = input?.kind === 'voice_preview' ? { ...tts, localNeural: { ...tts.localNeural, voiceId: input.voiceId } } : tts;
            if (!await operationCurrent()) return { status: 'cancelled' };
            const { createVoicePlaybackController } = await import('@/voice/runtime/playback/VoicePlaybackController');
            const { localNeuralTtsPreviewController } = await import('./panels/localTts/providers/localNeural/previewLocalNeuralTts');
            const preview = previewTts.provider === 'local_neural'
                ? localNeuralTtsPreviewController.begin(previewTts.localNeural.voiceId) : null;
            const playback = preview ? null : createVoicePlaybackController();
            const interrupt = () => { if (preview) preview.finish(); else playback?.interrupt(); };
            context.signal?.addEventListener('abort', interrupt, { once: true });
            try {
                primeWebAudioPlayback();
                await spec.test({ cfgTts: previewTts, voice, networkTimeoutMs: cfg.networkTimeoutMs, sample: t('settingsVoice.local.testTtsSample'),
                    signal: context.signal, isCurrent: () => selectionCurrent() && (preview?.isCurrent() ?? true),
                    registerPlaybackStopper: preview?.registerPlaybackStopper ?? playback!.registerStopper.captureAttempt!() });
                return await operationCurrent() && (preview?.isCurrent() ?? true) ? completed() : { status: 'cancelled' };
            } catch (error) {
                // Stop or replacement retires this sample even when native
                // synthesis/playback rejects while unwinding its cancellation.
                if (preview && !preview.isCurrent()) return { status: 'cancelled' };
                throw error;
            } finally {
                context.signal?.removeEventListener('abort', interrupt);
                interrupt();
            }
        }
        const role = operation.startsWith('tts_') ? 'tts_sherpa' : 'stt_sherpa';
        const selected = role === 'tts_sherpa' ? tts : stt;
        const isRoleModel = operation.startsWith('stt_') || operation.startsWith('tts_');
        if (isRoleModel && purpose === 'conversation' && voice.providerId !== 'local_direct' && voice.providerId !== 'local_conversation') return unavailable('local_voice_service_not_selected');
        if (isRoleModel && selected.provider !== 'local_neural') return unavailable('local_neural_engine_not_selected');
        const packId = input?.kind === 'model_pack' ? resolveCanonicalModelPackId(input.packId)
            : resolveCanonicalModelPackId(selected.localNeural.assetId ?? getDefaultModelPackId(role) ?? '');
        if (isRoleModel && input?.kind === 'model_pack' && packId !== resolveCanonicalModelPackId(selected.localNeural.assetId ?? getDefaultModelPackId(role) ?? '')) return unavailable('selected_model_pack_changed');
        const execution = isRoleModel ? resolveLocalNeuralExecutionPolicy({ requestedExecution: selected.localNeural.execution }).preferredExecution : 'daemon';
        if (cancelsModel) {
            if (!cancellation || cancellation.target.execution !== execution
                || execution === 'daemon' && cancellation.target.machineId !== machineId) return unavailable('model_operation_changed');
            if (!await operationCurrent()) return { status: 'cancelled' };
            return await cancellation.cancel(context.signal) ? completed({ packId }) : unavailable('model_operation_changed');
        }
        if (isRoleModel && execution === 'device') {
            if (!packId) return unavailable('model_pack_unselected');
            const { invokeVoiceDeviceModelPackOperation } = await import('./voiceDeviceModelPackOperation');
            return await invokeVoiceDeviceModelPackOperation({ operation: operation.endsWith('_remove') ? 'remove' : operation.endsWith('_update') ? 'update' : 'prepare',
                packId, role, signal: context.signal, isCurrent: operationCurrent,
                onDownloadStarted: modelPresentation?.onDownloadStarted,
                onProgress: modelPresentation?.onProgress,
                onUpdateChecked: modelPresentation?.onUpdateChecked });
        }
        if (operation === 'readiness_inspect') {
            if (purpose === 'conversation' && !voice.providerId) return unavailable('provider_unselected');
            const inspection = await inspectVoiceSettingsSemanticReadiness({ settings, purpose, context,
                machine: resolveVoiceExecutionMachinePresentationFromState(storage.getState()), isCurrent: selectionCurrent });
            return await operationCurrent() ? completed(inspection) : { status: 'cancelled' };
        }
        if (!machineId) return unavailable('execution_machine_unavailable');
        const client = new DaemonVoiceInferenceClient();
        const scope = { machineId };
        const catalog = captureDaemonVoiceModelCatalogObservation(machineId);
        if (operation === 'models_inspect') {
            const statuses = await catalog.read({ client, requireNewObservation: true, isCurrent: selectionCurrent, signal: context.signal });
            return statuses && await operationCurrent() ? completed({ machineId, models: statuses }) : { status: 'cancelled' };
        }
        if (!packId) return unavailable('model_pack_unselected');
        if (operation.endsWith('_update')) return unavailable('daemon_model_update_unsupported');
        const statuses = await catalog.read({ client, packIds: [packId], requireNewObservation: true, isCurrent: selectionCurrent, signal: context.signal });
        if (!statuses) return { status: 'cancelled' };
        const rows = buildModelCatalogRows({ statuses, selectedSttPackId: stt.localNeural.assetId, selectedTtsPackId: tts.localNeural.assetId });
        const row = [...rows.stt, ...rows.tts].find(candidate => candidate.packId === packId);
        if (!row) return unavailable('model_pack_unavailable');
        if (!await operationCurrent()) return { status: 'cancelled' };
        if (operation === 'model_default') {
            if (!row.canRemove || row.state === 'unsupported' || row.state === 'unknown') return unavailable('model_not_installed');
            await context.mutateSettings(latest => {
                const next = updateVoiceLocalConversationSetting(latest.voice, row.kind === 'stt_sherpa' ? 'stt.localNeural.assetId' : 'tts.localNeural.assetId', packId);
                return selectionCurrent() && material(latest) === capturedMaterial && next ? { voice: next } : null;
            });
            return selectionCurrent() ? completed({ packId }) : { status: 'cancelled' };
        }
        return await invokeDaemonModelPackOperation({ operation: operation === 'model_remove' || operation.endsWith('_remove') ? 'remove' : 'install',
            row, client, scope, signal: context.signal, isCurrent: operationCurrent });
    } catch (error) {
        modelPresentation?.onError?.(error);
        if (!current()) return { status: 'cancelled' };
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
        // Error messages can contain provider/credential material; return only structural known codes.
        return unavailable(code && ['feature_disabled', 'connected_purpose_catalog_unavailable', 'machine_unreachable', 'runtime_unavailable', 'unsupported_runtime_family', 'request_timeout', 'internal_error', 'invalid_response'].includes(code) ? code : 'voice_settings_operation_failed');
    }
}

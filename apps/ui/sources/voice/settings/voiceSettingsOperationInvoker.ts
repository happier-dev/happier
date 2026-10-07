import { Platform } from 'react-native';
import { StrictJsonValueSchema, VoiceRuntimePlatformSchema, getDefaultModelPackId, listModelPackCatalogEntries, resolveCanonicalModelPackId } from '@happier-dev/protocol';
import type { SettingOperationContext, SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { Modal } from '@/modal';
import type { Settings } from '@/sync/domains/settings/settings';
import { readLocalConversationVoiceSettings, readLocalDirectVoiceSettings, readVoiceDiagnosticsSettings, readVoiceProviderSettingsConfig, voiceSettingsParse, writeVoiceDiagnosticsSettings } from '@/sync/domains/settings/voiceSettings';
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
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { projectVoiceProviderSettings } from '@/voice/registry/providerRegistry';
import { inspectVoiceDictationSettingsReadiness, inspectVoiceProviderReadiness, projectVoiceRawSpeechReadinessTargets } from './voiceProviderReadinessInspection';
import { projectVoiceProviderAgentRealtimePassiveSetup, readVoiceProviderConnectedServicesBinding } from './passiveSetup';
import type { VoiceSettingsOperation } from './voiceSettingsOperation';

const unavailable = (reason: string): SettingOperationResult => ({ status: 'unavailable', reason });
const completed = (value?: unknown): SettingOperationResult => ({ status: 'completed', ...(value === undefined ? {} : { value: StrictJsonValueSchema.parse(value) }) });

/** Actions adapt the existing operation owners. They never infer success from opening a row. */
export async function invokeVoiceSettingsOperation(operation: VoiceSettingsOperation, purpose: 'conversation' | 'dictation', context: SettingOperationContext): Promise<SettingOperationResult> {
    const input = context.input;
    if (['model_install', 'model_remove', 'model_default'].includes(operation) && input?.kind !== 'model_pack'
        || operation === 'diagnostics_export' && input?.kind !== 'diagnostics_export'
        || operation === 'diagnostics_session_opt_out' && input?.kind !== 'diagnostics_session'
        || operation === 'diagnostics_retry_shutdown' && input?.kind !== 'diagnostics_revocation'
        || operation === 'diagnostics_enabled' && input?.kind !== 'diagnostics_enabled') return unavailable('operation_input_required');
    const acceptsModel = ['model_install', 'model_remove', 'model_default', 'stt_prepare', 'stt_remove', 'stt_update', 'tts_prepare', 'tts_remove', 'tts_update'].includes(operation);
    if (input && !(acceptsModel && input.kind === 'model_pack'
        || operation === 'tts_preview' && input.kind === 'voice_preview'
        || operation === 'diagnostics_export' && input.kind === 'diagnostics_export'
        || operation === 'diagnostics_session_opt_out' && input.kind === 'diagnostics_session'
        || operation === 'diagnostics_retry_shutdown' && input.kind === 'diagnostics_revocation'
        || operation === 'diagnostics_enabled' && input.kind === 'diagnostics_enabled')) return unavailable('operation_input_invalid');
    const current = () => !context.signal?.aborted && context.isCurrent();
    if (!current()) return { status: 'cancelled' };
    try {
        const settings = await context.readSettings();
        throwIfAborted(context.signal);
        if (!current()) return { status: 'cancelled' };
        const voice = voiceSettingsParse(settings.voice);
        const machineId = resolveVoiceExecutionMachineId();
        const material = (latest: Settings) => JSON.stringify(latest.voice);
        const capturedMaterial = material(settings);
        const selectionCurrent = () => current() && resolveVoiceExecutionMachineId() === machineId;
        const operationCurrent = async () => selectionCurrent() && material(await context.readSettings()) === capturedMaterial;
        if (input && 'machineId' in input && input.machineId && input.machineId !== machineId) return unavailable('execution_machine_changed');

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
        if (operation.startsWith('diagnostics_')) {
            if (!machineId) return unavailable('execution_machine_unavailable');
            const client = createVoiceDiagnosticsClientForMachine(machineId);
            if (operation === 'diagnostics_inspect') {
                const status = await client.status(context.signal);
                return await operationCurrent() ? completed(status) : { status: 'cancelled' };
            }
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
            const playback = createVoicePlaybackController();
            const interrupt = () => playback.interrupt();
            context.signal?.addEventListener('abort', interrupt, { once: true });
            try {
                await spec.test({ cfgTts: previewTts, voice, networkTimeoutMs: cfg.networkTimeoutMs, sample: t('settingsVoice.local.testTtsSample'),
                    signal: context.signal, isCurrent: selectionCurrent, registerPlaybackStopper: playback.registerStopper.captureAttempt?.() ?? playback.registerStopper });
                return await operationCurrent() ? completed() : { status: 'cancelled' };
            } finally {
                context.signal?.removeEventListener('abort', interrupt);
                playback.interrupt();
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
        if (isRoleModel && execution === 'device') {
            if (!packId) return unavailable('model_pack_unselected');
            const { invokeVoiceDeviceModelPackOperation } = await import('./voiceDeviceModelPackOperation');
            return invokeVoiceDeviceModelPackOperation({ operation: operation.endsWith('_remove') ? 'remove' : operation.endsWith('_update') ? 'update' : 'prepare',
                packId, role, signal: context.signal, isCurrent: operationCurrent });
        }
        if (operation === 'readiness_inspect' && purpose === 'dictation') {
            const registry = createDefaultVoiceProviderRegistry();
            const { resolveVoiceDictationNativeLocalNeuralModelSelection } = await import('@/voice/dictation/voiceDictationReadiness');
            const platform = VoiceRuntimePlatformSchema.safeParse(Platform.OS);
            const selection = resolveVoiceDictationNativeLocalNeuralModelSelection({ registry, settings, platform: platform.success ? platform.data : 'unknown' });
            const inspection = await inspectVoiceDictationSettingsReadiness({ packId: selection.packId,
                rawTarget: projectVoiceRawSpeechReadinessTargets(settings, registry, machineId, 'dictation')[0] ?? null, signal: context.signal });
            return await operationCurrent() ? completed({ providerId: selection.providerId, machineId, nativeModelPackId: selection.packId, ...inspection }) : { status: 'cancelled' };
        }
        if (!machineId) return unavailable('execution_machine_unavailable');
        const client = new DaemonVoiceInferenceClient();
        const scope = { machineId };
        if (operation === 'readiness_inspect') {
            const registry = createDefaultVoiceProviderRegistry();
            const providerId = purpose === 'dictation' ? stt.provider : voice.providerId;
            if (!providerId) return unavailable('provider_unselected');
            const entry = registry.get(providerId);
            if (!entry) return unavailable('provider_unavailable');
            const envelope = voice.providers[entry.providerId] ?? null;
            const projection = projectVoiceProviderSettings(entry, envelope);
            const config = readVoiceProviderSettingsConfig(voice, entry.providerId) ?? entry.providerSettings?.defaultConfig ?? null;
            const passiveSetup = entry.kind === 'voice.conversation-provider.v1' && entry.declaration?.kind === 'conversation'
                ? projectVoiceProviderAgentRealtimePassiveSetup(entry.declaration.execution) : null;
            const connectedServices = readVoiceProviderConnectedServicesBinding({ providerSettings: entry.providerSettings ?? null, providerConfig: config });
            const rawTargets = purpose === 'conversation' && voice.providerId === 'local_conversation'
                ? projectVoiceRawSpeechReadinessTargets(settings, registry, machineId) : [];
            if (!await operationCurrent()) return { status: 'cancelled' };
            const inspection = await inspectVoiceProviderReadiness({ machineId, passiveSetup, connectedServices, rawTargets, signal: context.signal, isCurrent: selectionCurrent });
            if (!await operationCurrent()) return { status: 'cancelled' };
            const models = providerId === 'local_direct' || providerId === 'local_conversation' || providerId === 'local_neural'
                ? await client.getModelsStatus([stt.localNeural.assetId ?? getDefaultModelPackId('stt_sherpa'), tts.localNeural.assetId ?? getDefaultModelPackId('tts_sherpa')].filter((id): id is string => Boolean(id)), scope) : [];
            return await operationCurrent() ? completed({ providerId, machineId, settings: projection, passiveRealtimeSetup: inspection.passive, rawCredentialAuthorization: inspection.raw, models }) : { status: 'cancelled' };
        }
        if (operation === 'models_inspect') {
            const [discovered, canonical] = await Promise.all([client.listModels(scope), client.getModelsStatus(listModelPackCatalogEntries().map(entry => entry.packId), scope)]);
            const statuses = [...new Map([...discovered, ...canonical].map(status => [status.packId, status])).values()];
            return await operationCurrent() ? completed({ machineId, models: statuses }) : { status: 'cancelled' };
        }
        if (!packId) return unavailable('model_pack_unselected');
        if (operation.endsWith('_update')) return unavailable('daemon_model_update_unsupported');
        const statuses = await client.getModelsStatus([packId], scope);
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
        if (!current()) return { status: 'cancelled' };
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
        // Error messages can contain provider/credential material; return only structural known codes.
        return unavailable(code && ['feature_disabled', 'machine_unreachable', 'runtime_unavailable', 'unsupported_runtime_family', 'request_timeout', 'internal_error', 'invalid_response'].includes(code) ? code : 'voice_settings_operation_failed');
    }
}

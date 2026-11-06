import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import type { ModelPackRowStatus } from '@/voice/settings/panels/modelPack/modelPackTransferRows';
import { isModelPackCancellation } from '@/voice/modelPacks/installer/network';
import { findRunningModelPackInstall, getModelPackInstallSummary } from '@/voice/modelPacks/installer.native';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { resumeActionExecutionResult } from '@/components/approvals/actionApprovalContinuation';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { useVoiceSttSettingRefs } from '@/voice/settings/useVoiceSttSettingRefs';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { describeModelPackInstallError } from '@/voice/settings/panels/modelPack/modelPackTransferRows';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { createVoiceModelCancellationCommand } from '@/voice/settings/voiceModelCancellation';
import { useCurrentUiContextMountedCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { retainDeep } from '@/sync/domains/state/structuralSharing';

type ModelStatus = ModelPackRowStatus;
type RunningInstall = NonNullable<Awaited<ReturnType<typeof findRunningModelPackInstall>>>;

/** Native STT and TTS share settings state; consent and installer admission live in the operation owner. */
export function useLocalNeuralModelPackState(params: {
  packId: string;
  role?: 'stt_sherpa' | 'tts_sherpa';
  enabled?: boolean;
  /** Publication controls observation only; manual preparation is admitted by its Action owner. */
  readEnabled?: boolean;
}) {
  const role = params.role ?? 'tts_sherpa';
  const enabled = params.enabled ?? true;
  const readEnabled = params.readEnabled ?? true;
  const settingsScope = useAccountSettingsScope();
  const sttSettings = useVoiceSttSettingRefs();
  const approval = useActionApprovalContinuation({
    scopeKey: JSON.stringify(settingsScope), serverId: settingsScope?.serverId ?? '',
    onExecuted: () => {},
  });
  const selectionRef = React.useRef({ packId: params.packId, role, enabled });
  React.useLayoutEffect(() => {
    // Suspended replacement renders must not retarget a committed operation.
    selectionRef.current = { packId: params.packId, role, enabled };
  }, [enabled, params.packId, role]);
  const mountedRef = React.useRef(true);
  const [modelStatus, setModelStatus] = React.useState<ModelStatus>('idle');
  const [downloadProgress, setDownloadProgress] = React.useState<unknown | null>(null);
  const prepareAbortRef = React.useRef<AbortController | null>(null);
  const [cancellationCommand, setCancellationCommand] = React.useState<ReturnType<typeof createVoiceModelCancellationCommand>>(null);
  useCurrentUiContextMountedCommand(cancellationCommand, t('common.cancel'));
  const [installed, setInstalled] = React.useState(false);
  const [installSummary, setInstallSummary] = React.useState<Awaited<ReturnType<typeof getModelPackInstallSummary>> | null>(null);
  const [updateCheckedRemote, setUpdateCheckedRemote] = React.useState<{ build: string | null; updateAvailable: boolean } | null>(null);

  const isCurrent = React.useCallback(() => mountedRef.current && enabled
    && selectionRef.current.enabled && selectionRef.current.packId === params.packId
    && selectionRef.current.role === role, [enabled, params.packId, role]);

  const refreshInstallState = React.useCallback(async () => {
    if (!isCurrent() || !readEnabled) return;
    const accountLifetime = captureActiveServerAccountScopeCurrentness();
    try {
      const summary = await getModelPackInstallSummary({ packId: params.packId });
      if (!isCurrent() || !accountLifetime.isCurrent()) return;
      setInstallSummary(current => retainDeep(current, summary));
      setInstalled(summary.installed);
      setModelStatus((cur) => cur === 'downloading' ? cur : summary.installed ? 'ready' : 'idle');
      setUpdateCheckedRemote(null);
      return summary;
    } catch (error) {
      if (!isCurrent() || !accountLifetime.isCurrent()) return;
      console.warn('[modelPacks] Failed to refresh native model pack state', error);
      setInstallSummary(null);
      setInstalled(false);
      setModelStatus((cur) => cur === 'downloading' ? cur : 'idle');
      setUpdateCheckedRemote(null);
    }
  }, [isCurrent, params.packId, readEnabled]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const controller = prepareAbortRef.current;
      if (!controller) return;
      // The installer owns admitted downloads. Pending consent or runtime-only preparation still
      // belongs to this view; account retirement and a changed committed selection always cancel.
      void findRunningModelPackInstall({ packId: selectionRef.current.packId }).then((running) => {
        if (!running) controller.abort();
      }).catch((error: unknown) => {
        console.warn('[modelPacks] Failed to detach native model pack view', error);
        controller.abort();
      });
    };
  }, []);

  const runOperation = React.useCallback(async (operation: 'prepare' | 'remove' | 'update', following?: RunningInstall) => {
    if (!isCurrent() || prepareAbortRef.current) return;
    const controller = new AbortController();
    const accountLifetime = captureActiveServerAccountScopeCurrentness();
    prepareAbortRef.current = controller;
    const accountRetirement = accountLifetime.onRetire(() => {
      controller.abort();
      if (prepareAbortRef.current === controller) prepareAbortRef.current = null;
      if (isCurrent()) {
        setCancellationCommand(null);
        setModelStatus(installed ? 'ready' : 'idle');
        setDownloadProgress(null);
      }
    });
    const current = () => isCurrent() && accountLifetime.isCurrent() && !controller.signal.aborted;
    const command = createVoiceModelCancellationCommand({ packId: params.packId, execution: 'device', machineId: null,
      account: 'scope' in accountLifetime ? accountLifetime : null, isCurrent: () => current() && prepareAbortRef.current === controller,
      cancel: () => controller.abort() });
    setCancellationCommand(command);
    let checkedUpdateAvailable: boolean | null = null;
    try {
      if (following) {
        setModelStatus('downloading');
        setDownloadProgress(null);
      }
      let operationError: unknown;
      const setting = role === 'stt_sherpa'
        ? sttSettings[operation === 'prepare' ? 'sttPrepareModel' : operation === 'remove' ? 'sttRemoveModel' : 'sttUpdateModel']
        : VOICE_CONVERSATIONS_SETTINGS.settings[operation === 'prepare' ? 'ttsPrepareModel' : operation === 'remove' ? 'ttsRemoveModel' : 'ttsUpdateModel'];
      const execute = createFrontDoorActionExecute(undefined, {
        hostActionApprovalLifetime: { actionId: 'settings.invoke', signal: controller.signal, surface: 'ui' },
        onBlockingApprovalPending: ({ artifactId, signal }) => {
          if (!current() || !('scope' in accountLifetime)) return;
          approval.requestApproval({ artifactId, scope: accountLifetime.scope, signal,
            refreshAfterExecution: false, onExecuted: async () => 'ignored' });
        },
        voiceModelPackPresentation: {
          isCurrent: current,
          onError: error => { operationError = error; },
          onDownloadStarted: () => {
            if (!current()) return;
            setModelStatus('downloading');
            setDownloadProgress(null);
          },
          onProgress: progress => { if (current()) setDownloadProgress(progress); },
          onUpdateChecked: status => {
            if (!current()) return;
            checkedUpdateAvailable = status.updateAvailable;
            setUpdateCheckedRemote(status);
          },
        },
      });
      const invoke = async () => {
        if (!('scope' in accountLifetime)) return { status: 'cancelled' as const };
        const actionInput = { anchor: setting.anchor, input: { kind: 'model_pack' as const, packId: params.packId } };
        const initial = await execute('settings.invoke', actionInput, {
          surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
          serverId: accountLifetime.scope.serverId, expectedAccountId: accountLifetime.scope.accountId,
          signal: controller.signal,
        });
        const result = await resumeActionExecutionResult({ result: initial, actionId: 'settings.invoke',
          actionInput, scope: accountLifetime.scope, signal: controller.signal, onApprovalPending: approval.requestApproval });
        if (operationError !== undefined) throw operationError;
        return result.ok ? SettingsDeclarationActionOutputSchemasV1['settings.invoke'].parse(result.result)
          : { status: 'cancelled' as const };
      };
      const result = following ? await following.follow({ signal: controller.signal,
        onProgress: progress => { if (current()) setDownloadProgress(progress); },
      }).then(() => ({ status: 'completed' as const })) : await invoke();
      if (!current()) return;
      if (result.status === 'unavailable') {
        if (result.reason === 'model_runtime_unsupported') {
          await Modal.alert(t('common.error'), t('settingsVoice.local.kokoro.alerts.runtimeUnsupported.body'));
        } else if (result.reason === 'model_manifest_unavailable') {
          await Modal.alert(t('settingsVoice.local.kokoro.alerts.missingManifest.title'),
            t('settingsVoice.local.kokoro.alerts.missingManifest.body'));
        } else if (result.reason === 'model_not_installed') {
          await Modal.alert(
            t(role === 'stt_sherpa' ? 'settingsVoice.local.localNeuralStt.alerts.notInstalledTitle' : 'settingsVoice.local.kokoro.alerts.notInstalledTitle'),
            t(role === 'stt_sherpa' ? 'settingsVoice.local.localNeuralStt.alerts.notInstalledBody' : 'settingsVoice.local.kokoro.alerts.notInstalledBody'));
        }
        return;
      }
      if (result.status !== 'completed') return;
      if (operation === 'update' && checkedUpdateAvailable === false) {
        await Modal.alert(
          t(role === 'stt_sherpa' ? 'settingsVoice.local.kokoro.updates.upToDate' : 'settingsVoice.local.kokoro.alerts.upToDateTitle'),
          t(role === 'stt_sherpa' ? 'settingsVoice.local.localNeuralStt.alerts.upToDateBody' : 'settingsVoice.local.kokoro.alerts.upToDateBody'));
        return;
      }
      setModelStatus(operation === 'remove' ? 'idle' : 'ready');
      await refreshInstallState();
      if (operation === 'update' && current()) {
        await Modal.alert(
          t(role === 'stt_sherpa' ? 'settingsVoice.local.localNeuralStt.alerts.updatedTitle' : 'settingsVoice.local.kokoro.alerts.updatedTitle'),
          t(role === 'stt_sherpa' ? 'settingsVoice.local.localNeuralStt.alerts.updatedBody' : 'settingsVoice.local.kokoro.alerts.updatedBody'));
      }
    } catch (error) {
      if (!isCurrent() || !accountLifetime.isCurrent()) return;
      if (isModelPackCancellation(error, controller.signal)) {
        setModelStatus('idle');
        await refreshInstallState();
        return;
      }
      const summary = await refreshInstallState();
      if (!isCurrent() || !accountLifetime.isCurrent()) return;
      setModelStatus(operation === 'update' && summary?.installed ? 'ready' : 'error');
      const message = describeModelPackInstallError(error);
      if (operation === 'update') {
        await Modal.alert(
          t(role === 'stt_sherpa' ? 'settingsVoice.local.localNeuralStt.alerts.updateFailedTitle' : 'settingsVoice.local.kokoro.alerts.updateFailedTitle'),
          role === 'stt_sherpa'
            ? t('settingsVoice.local.localNeuralStt.alerts.updateFailedBody', { message })
            : t('settingsVoice.local.kokoro.alerts.updateFailedBody', { message }));
      } else if (role === 'stt_sherpa' && operation === 'prepare') {
        await Modal.alert(t('settingsVoice.local.localNeuralStt.alerts.downloadFailedTitle'),
          t('settingsVoice.local.localNeuralStt.alerts.downloadFailedBody', { message }));
      } else {
        await Modal.alert(t('common.error'), message);
      }
    } finally {
      accountRetirement.dispose();
      if (prepareAbortRef.current === controller) {
        prepareAbortRef.current = null;
        if (isCurrent()) {
          setCancellationCommand(current => current === command ? null : current);
          setDownloadProgress(null);
        }
      }
    }
  }, [approval.requestApproval, installed, isCurrent, params.packId, refreshInstallState, role, sttSettings]);

  const runOperationRef = React.useRef(runOperation);
  React.useLayoutEffect(() => { runOperationRef.current = runOperation; }, [runOperation]);
  React.useEffect(() => {
    prepareAbortRef.current?.abort();
    prepareAbortRef.current = null;
    setCancellationCommand(null);
    setModelStatus('idle');
    setDownloadProgress(null);
    setInstalled(false);
    setInstallSummary(null);
    setUpdateCheckedRemote(null);
    fireAndForget((async () => {
      if (!isCurrent() || !readEnabled) return;
      const running = await findRunningModelPackInstall({ packId: params.packId, kind: role });
      if (!isCurrent()) return;
      if (running) await runOperationRef.current('prepare', running);
      else await refreshInstallState();
    })(), { tag: 'useLocalNeuralModelPackState.followRunningInstall' });
  }, [isCurrent, params.packId, readEnabled, refreshInstallState, role]);

  const prepareModel = React.useCallback(() => runOperation('prepare'), [runOperation]);
  const cancelPrepare = React.useCallback(() => { prepareAbortRef.current?.abort(); }, []);
  const clearAssets = React.useCallback(() => {
    fireAndForget(runOperation('remove'), { tag: 'useLocalNeuralModelPackState.clearAssets' });
  }, [runOperation]);
  const checkForUpdates = React.useCallback(() => {
    fireAndForget(runOperation('update'), { tag: 'useLocalNeuralModelPackState.checkForUpdates' });
  }, [runOperation]);

  return { modelStatus, downloadProgress, installed, installSummary, updateCheckedRemote,
    refreshInstallState, prepareModel, cancelPrepare, clearAssets, checkForUpdates } as const;
}

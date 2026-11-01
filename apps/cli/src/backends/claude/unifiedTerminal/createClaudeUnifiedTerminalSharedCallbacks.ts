import type { EnhancedMode } from '../loop';
import type { Session } from '../session';
import { applyClaudeEffectiveModelUpdate } from '../sessionModels/effectiveModelUpdate';
import type { reconcileClaudeSessionModelsState } from '../sessionModels/reconcileClaudeSessionModelsState';
import { delay } from '@/utils/time';

import type { ClaudeInFlightSteerAvailabilitySnapshot } from './createClaudeInFlightSteerCapabilityPublisher';
import type { ClaudeUnifiedDialogChoiceBroker } from './dialogChoice/claudeUnifiedDialogChoiceBroker';
import {
  createClaudeUnifiedSustainedPendingDeliveryBlockHandler,
  resolveClaudeUnifiedDraftGuardStarvationBlocker,
} from './claudeUnifiedPendingDeliveryBlockHandling';
import { createClaudeUnifiedResumeChoiceStartupResolver } from './resumeChoice/claudeUnifiedResumeChoiceStartupResolver';
import type {
  ClaudeUnifiedTerminalSessionOptions,
  ClaudeUnifiedTuiRuntimeControlOptions,
} from './runClaudeUnifiedTerminalSession';
import {
  buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent,
  isClaudeUnifiedRuntimeControlUserDraftBlocker,
  type ClaudeUnifiedRuntimeControlApplyResult,
} from './runtimeControlIntegration';
import { createTerminalComposerDraftBlockedEvent } from './terminalComposerDraftBlockedEvent';
import { DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS } from './tuiControls';
import type { ClaudeScreenState } from './tuiControls/screenState';

type MetadataRuntimeModeApplier<Mode extends EnhancedMode> =
  (mode: Mode) => Promise<ClaudeUnifiedRuntimeControlApplyResult>;

type SharedCallbacks<Mode extends EnhancedMode> =
  Pick<
    ClaudeUnifiedTerminalSessionOptions<Mode>,
    'onDraftGuardStarvation' | 'onDraftGuardClear' | 'createStartupDialogResolver'
  >
  & Readonly<{
    tuiRuntimeControl: Pick<
      ClaudeUnifiedTuiRuntimeControlOptions<Mode>,
      | 'featureEnabled'
      | 'emitRuntimeConfigOutcome'
      | 'onBlockedApplyStarvation'
      | 'onBlockedApplyClear'
      | 'registerStatuslineRuntimeReconciler'
      | 'registerMetadataRuntimeModeApplier'
    >;
  }>;

export function createClaudeUnifiedTerminalSharedCallbacks<Mode extends EnhancedMode>(
  params: Readonly<{
    sessionClient: Pick<Session['client'], 'sendSessionEvent' | 'hasActiveCanonicalTurn' | 'updateMetadata' | 'getMetadataSnapshot'>;
    reconcileModels: typeof reconcileClaudeSessionModelsState;
    observeInFlightSteerAvailabilitySnapshot: (snapshot: ClaudeInFlightSteerAvailabilitySnapshot) => void;
    sustainedPendingDeliveryBlockHandler: ReturnType<
      typeof createClaudeUnifiedSustainedPendingDeliveryBlockHandler
    >;
    dialogChoiceBroker: ClaudeUnifiedDialogChoiceBroker;
    tuiRuntimeControlEnabled: boolean;
    registerStatuslineRuntimeReconciler:
      NonNullable<ClaudeUnifiedTuiRuntimeControlOptions<Mode>['registerStatuslineRuntimeReconciler']>;
    getMetadataRuntimeModeApplier: () => MetadataRuntimeModeApplier<Mode> | null;
    setMetadataRuntimeModeApplier: (apply: MetadataRuntimeModeApplier<Mode> | null) => void;
    flushPendingMetadataMode: () => Promise<unknown>;
    onStartupDialogWaitingForUser?: ((screenState: ClaudeScreenState) => void | Promise<void>) | undefined;
    logPrefix: string;
    logDebug: (message: string, error: unknown) => void;
  }>,
): SharedCallbacks<Mode> {
  const wakePendingMaterialization = () => {
    params.sustainedPendingDeliveryBlockHandler.wakePendingMaterialization();
  };

  return {
    onDraftGuardStarvation: (info) => {
      if (info.guardStatus !== 'blocked_non_input_state') {
        params.observeInFlightSteerAvailabilitySnapshot({
          available: false,
          reason: 'user_terminal_draft',
        });
      }
      void params.sustainedPendingDeliveryBlockHandler.blockForSustainedBlocker({
        localIds: info.userMessageLocalIds,
        blocker: resolveClaudeUnifiedDraftGuardStarvationBlocker(info),
        isCanonicalTurnActive:
          info.isCanonicalTurnActive
          ?? (params.sessionClient.hasActiveCanonicalTurn?.() ?? true),
      }).then((blocked) => {
        if (!blocked && info.guardStatus !== 'blocked_non_input_state') {
          params.sessionClient.sendSessionEvent(
            createTerminalComposerDraftBlockedEvent('idle_draft_guard'),
          );
        }
      });
    },
    onDraftGuardClear: wakePendingMaterialization,
    createStartupDialogResolver: ({
      controlPort,
      startupMode,
      isRuntimeControlInFlight,
      onResumeSummaryCompactionSubmitted,
    }) => {
      const resolveStartupDialog = createClaudeUnifiedResumeChoiceStartupResolver({
        choice: startupMode.claudeUnifiedTerminalResumeChoice ?? 'ask_every_time',
        broker: params.dialogChoiceBroker,
        port: controlPort,
        wait: delay,
        settleMs: DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.commandSettleMs,
        startupMode,
        isRuntimeControlInFlight,
        onResumeSummaryCompactionSubmitted,
      });
      return async (input) => {
        const resolution = await resolveStartupDialog(input);
        if (resolution.status === 'waiting_for_user') {
          await params.onStartupDialogWaitingForUser?.(input.screenState);
        }
        return resolution;
      };
    },
    tuiRuntimeControl: {
      featureEnabled: params.tuiRuntimeControlEnabled,
      emitRuntimeConfigOutcome: (event) => {
        const effort = event.changes.find(change => change.key === 'reasoningEffort');
        if (event.status === 'applied'
          && event.timing !== 'scheduled_for_next_prompt'
          && event.timing !== 'queued_until_safe_window'
          && event.timing !== 'next_idle'
          && effort?.reason !== 'delivered_unverified'
          && typeof effort?.effective === 'string') {
          const model = event.changes.find(change => change.key === 'model');
          const modelId = typeof model?.effective === 'string' && model.reason !== 'delivered_unverified'
            ? model.effective
            : undefined;
          applyClaudeEffectiveModelUpdate({
            client: params.sessionClient, reconcileModels: params.reconcileModels,
            modelId, reasoningEffort: effort.effective, source: 'control', logPrefix: params.logPrefix,
          });
        }
        params.sessionClient.sendSessionEvent(
          buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent(event),
        );
      },
      onBlockedApplyStarvation: (info) => {
        if (isClaudeUnifiedRuntimeControlUserDraftBlocker(info.blockedReason)) {
          params.observeInFlightSteerAvailabilitySnapshot({
            available: false,
            reason: 'user_terminal_draft',
          });
          void params.sustainedPendingDeliveryBlockHandler.blockForSustainedBlocker({
            localIds: info.userMessageLocalIds,
            blocker: {
              kind: 'runtime_config_blocked',
              source: 'runtime_control',
              blockedReason: info.blockedReason,
            },
            isCanonicalTurnActive:
              info.isCanonicalTurnActive
              ?? (params.sessionClient.hasActiveCanonicalTurn?.() ?? true),
          }).then((blocked) => {
            if (!blocked) {
              params.sessionClient.sendSessionEvent(
                createTerminalComposerDraftBlockedEvent('idle_draft_guard'),
              );
            }
          });
          return;
        }
        params.sessionClient.sendSessionEvent({
          type: 'message',
          message: 'Your queued message is waiting: the terminal shows a draft or dialog that blocks applying your settings change. Clear the terminal composer (or dismiss the dialog) to deliver it.',
        });
      },
      onBlockedApplyClear: wakePendingMaterialization,
      registerStatuslineRuntimeReconciler: params.registerStatuslineRuntimeReconciler,
      registerMetadataRuntimeModeApplier: (apply) => {
        params.setMetadataRuntimeModeApplier(apply);
        void params.flushPendingMetadataMode().catch((error) => {
          params.logDebug(
            `${params.logPrefix}: failed to flush pending metadata runtime mode after applier registration`,
            error,
          );
        });
        return () => {
          if (params.getMetadataRuntimeModeApplier() === apply) {
            params.setMetadataRuntimeModeApplier(null);
          }
        };
      },
    },
  };
}

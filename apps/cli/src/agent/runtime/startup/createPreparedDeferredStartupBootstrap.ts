import { randomUUID } from 'node:crypto';

import type { SessionAttachMetadataIdentityPolicy, SessionModelSelectionV1 } from '@happier-dev/protocol';

import type {
  ApiSessionClient,
  ApiSessionClientOptions,
} from '@/api/session/sessionClient';
import type { MachineMetadata, PermissionMode } from '@/api/types';
import type { BackendFlavor, SessionLaunchControlMetadata } from '@/agent/runtime/createSessionMetadata';
import { createDeferredStartupBootstrap } from '@/agent/runtime/startup/createDeferredStartupBootstrap';
import { createDeferredStartupMetadataPlan } from '@/agent/runtime/startup/createDeferredStartupMetadataPlan';
import type {
  DeferredStartupPushSender,
  DeferredStartupRegisteredStateMutationFactory,
} from '@/agent/runtime/startup/deferredStartupTypes';
import { createStartupTiming } from '@/agent/runtime/startup/startupTiming';
import type { InitializeBackendRunSessionOptions } from '@/agent/runtime/initializeBackendRunSession';
import type { Credentials } from '@/persistence';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import { configuration } from '@/configuration';

import { createTimedDeferredStartupBootstrap, type TimedDeferredStartupBootstrapResult } from './createTimedDeferredStartupBootstrap';
import type { DeferredStartupBootstrapResult } from './deferredStartupTypes';
import type { StartupTiming } from './startupSpec';

const DEFAULT_MISSING_MACHINE_ID_MESSAGE =
  '[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/happier-dev/happier/issues';

export async function createPreparedDeferredStartupBootstrap(params: Readonly<{
  credentials: Credentials;
  flavor: BackendFlavor;
  workingDirectory: string;
  startedBy: 'terminal' | 'daemon';
  initialMachineId: string;
  machineMetadata: MachineMetadata;
  uiLogPrefix: string;
  timingLogPrefix: string;
  timingIncludeIds?: ReadonlyArray<string>;
  initialPermissionMode: PermissionMode;
  explicitPermissionMode?: PermissionMode;
  explicitPermissionModeUpdatedAt?: number;
  sessionModeId?: string | null;
  sessionModeUpdatedAt?: number;
  modelSelection?: SessionModelSelectionV1;
  terminalRuntime?: TerminalRuntimeFlags | null;
  launchControlMetadata: SessionLaunchControlMetadata;
  existingSessionId?: string;
  sessionAttachFilePath?: string;
  attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy | null;
  sessionTag?: string;
  allowOfflineStub?: boolean;
  startupSideEffectsOrder?: InitializeBackendRunSessionOptions['startupSideEffectsOrder'];
  missingMachineIdMessage?: string;
  onBackgroundStartFailure?: (error: unknown, context: Readonly<{ timing: StartupTiming }>) => void | Promise<void>;
  onSessionAttached?: (params: Readonly<{
    session: ApiSessionClient;
    machineId: string;
    timing: StartupTiming;
  }>) => void | Promise<void>;
  onPushSenderReady?: ((pushSender: DeferredStartupPushSender) => void | Promise<void>) | null;
  createInitialRegisteredSessionStateFieldMutations?: DeferredStartupRegisteredStateMutationFactory;
  transformSessionInputBeforeCommit?: ApiSessionClientOptions['transformSessionInputBeforeCommit'];
}>): Promise<TimedDeferredStartupBootstrapResult<DeferredStartupBootstrapResult>> {
  const metadataPlan = createDeferredStartupMetadataPlan({
    flavor: params.flavor,
    initialMachineId: params.initialMachineId,
    directory: params.workingDirectory,
    startedBy: params.startedBy,
    terminalRuntime: params.terminalRuntime ?? null,
    initialPermissionMode: params.initialPermissionMode,
    explicitPermissionMode: params.explicitPermissionMode,
    explicitPermissionModeUpdatedAt: params.explicitPermissionModeUpdatedAt,
    sessionModeId: params.sessionModeId ?? undefined,
    sessionModeUpdatedAt: params.sessionModeUpdatedAt,
    modelSelection: params.modelSelection,
    launchControlMetadata: params.launchControlMetadata,
  });
  const timing = createStartupTiming({ enabled: configuration.startupTimingEnabled, nowMs: () => Date.now() });

  const bootstrap = await createDeferredStartupBootstrap({
    credentials: params.credentials,
    startedBy: params.startedBy,
    initialMachineId: params.initialMachineId,
    machineMetadata: params.machineMetadata,
    missingMachineIdMessage: params.missingMachineIdMessage ?? DEFAULT_MISSING_MACHINE_ID_MESSAGE,
    sessionTag: params.sessionTag ?? randomUUID(),
    existingSessionId: params.existingSessionId,
    sessionAttachFilePath: params.sessionAttachFilePath,
    attachMetadataIdentityPolicy: params.attachMetadataIdentityPolicy,
    initialMetadata: metadataPlan.initialMetadata,
    createInitializedSessionMetadata: metadataPlan.createInitializedSessionMetadata,
    uiLogPrefix: params.uiLogPrefix,
    startupMetadataOverrides: metadataPlan.startupMetadataOverrides,
    allowOfflineStub: params.allowOfflineStub,
    startupSideEffectsOrder: params.startupSideEffectsOrder,
    onBackgroundStartFailure: async (error) => {
      await params.onBackgroundStartFailure?.(error, { timing });
    },
    onSessionAttached: async (attached) => {
      await params.onSessionAttached?.({
        ...attached,
        timing,
      });
    },
    onPushSenderReady: params.onPushSenderReady,
    createInitialRegisteredSessionStateFieldMutations:
      params.createInitialRegisteredSessionStateFieldMutations,
    transformSessionInputBeforeCommit: params.transformSessionInputBeforeCommit,
  });

  return createTimedDeferredStartupBootstrap({
    bootstrap,
    timing,
    logPrefix: params.timingLogPrefix,
    includeIds: params.timingIncludeIds,
  });
}

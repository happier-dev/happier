import { createUnavailableRuntimeActionExecutor } from '@happier-dev/protocol/actions/executor/dispatch';
import type { BrowserCommandV1 } from '@happier-dev/protocol/browser/control/v1';
import type { RuntimeActionExecute, RuntimeActionExecuteArgs } from '@happier-dev/protocol/actions/executor/types';

import {
    createBrowserRuntimeActionExecutor,
    type BrowserRuntimeAutomationAdapter,
    type BrowserRuntimeControlAdapter,
} from '@/sync/domains/browser/actions/runtimeActionExecutor';
import {
    readRegisteredBrowserRuntimeAutomationAdapter,
    readRegisteredBrowserRuntimeControlAdapter,
} from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { readRegisteredBrowserRecordingAttachAdapter } from '@/sync/domains/browser/recording/runtimeAttachRegistry';
import { readRegisteredBrowserContextAnnotationAdapter } from '@/sync/domains/browser/context/runtimeAnnotationRegistry';
import { createSimulatorPreviewRuntimeActionExecutor } from '@/sync/domains/devices/simulator/actions/runtimeActionExecutor';
import { createComputerRuntimeActionExecutor } from '@/sync/domains/computer/actions/runtimeActionExecutor';
import {
    createLocalServicesRuntimeActionExecutor,
    type CreateLocalServicesRuntimeActionExecutorInput,
} from '@/sync/domains/local/services/actions/runtimeActionExecutor';
import { executeLocalServiceActionViaMachineRpc } from '@/sync/domains/local/services/actions/machineRpc';
import { fetchLocalServiceInventorySnapshotViaMachineRpc } from '@/sync/domains/local/services/inventory/machineRpc';
import {
    fetchLocalServiceLauncherSnapshotViaMachineRpc,
    startLocalServiceLauncherTargetViaMachineRpc,
} from '@/sync/domains/local/services/launch/machineRpc';
import { fetchLocalServicePreviewSnapshotViaMachineRpc } from '@/sync/domains/local/services/preview/machineRpc';
import {
    copyLocalServicePublicPreviewUrlViaMachineRpc,
    createLocalServicePublicPreviewExposureViaMachineRpc,
    fetchLocalServicePublicPreviewStatusViaMachineRpc,
    revokeLocalServicePublicPreviewExposureViaMachineRpc,
} from '@/sync/domains/local/services/publicPreview/machineRpc';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { readCurrentProjectAccountRows, readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export type CreateDefaultRuntimeActionExecutorInput = Readonly<{
    browserControl?: BrowserRuntimeControlAdapter;
    browserAutomation?: BrowserRuntimeAutomationAdapter;
    localServices?: Omit<
        CreateLocalServicesRuntimeActionExecutorInput,
        | 'fallback'
        | 'resolveMachineId'
        | 'fetchPreviewSnapshot'
        | 'fetchPublicPreviewStatus'
        | 'createPublicPreviewExposure'
        | 'revokePublicPreviewExposure'
        | 'copyPublicPreviewUrl'
    >;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveSessionMachineId(args: RuntimeActionExecuteArgs): string | null {
    const sessionId = normalizeNonEmptyString(args.context.defaultSessionId);
    if (!sessionId) return null;
    return normalizeNonEmptyString(readMachineControlTargetForSession(sessionId)?.machineId);
}

type BrowserCommandWithSessionId = Extract<BrowserCommandV1, Readonly<{ browserSessionId: string }>>;

function isBrowserCommandWithSessionId(command: BrowserCommandV1): command is BrowserCommandWithSessionId {
    return 'browserSessionId' in command && typeof command.browserSessionId === 'string';
}

function resolveBrowserCommandSessionId(command: BrowserCommandV1): string | null {
    return isBrowserCommandWithSessionId(command) ? normalizeNonEmptyString(command.browserSessionId) : null;
}

export function createDefaultRuntimeActionExecutor(
    input: CreateDefaultRuntimeActionExecutorInput = {},
    accountLifetime?: ServerAccountScopeLifetime,
): RuntimeActionExecute {
    const fallback = createUnavailableRuntimeActionExecutor();
    const simulator = createSimulatorPreviewRuntimeActionExecutor({
        resolveMachineId: resolveSessionMachineId,
        fallback,
    });
    // The person's computer controls (choose a window, stop, hand back) go to the machine they name.
    const computer = createComputerRuntimeActionExecutor({ fallback: simulator, accountLifetime });
    const localServices = createLocalServicesRuntimeActionExecutor({
        ...input.localServices,
        readWorkspaceRefs: input.localServices?.readWorkspaceRefs ?? (() => {
            const state = readRegisteredStorageState();
            if (!state) return null;
            const current = readCurrentProjectAccountRows(state);
            return current?.status === 'ready'
                ? { ...current.scope, refs: readProjectWorkspaceRefs(state) }
                : null;
        }),
        resolveMachineId: resolveSessionMachineId,
        fetchInventorySnapshot: input.localServices?.fetchInventorySnapshot ?? fetchLocalServiceInventorySnapshotViaMachineRpc,
        fetchLauncherSnapshot: input.localServices?.fetchLauncherSnapshot ?? fetchLocalServiceLauncherSnapshotViaMachineRpc,
        startLauncherTarget: input.localServices?.startLauncherTarget ?? startLocalServiceLauncherTargetViaMachineRpc,
        fetchPreviewSnapshot: fetchLocalServicePreviewSnapshotViaMachineRpc,
        fetchPublicPreviewStatus: fetchLocalServicePublicPreviewStatusViaMachineRpc,
        createPublicPreviewExposure: createLocalServicePublicPreviewExposureViaMachineRpc,
        revokePublicPreviewExposure: revokeLocalServicePublicPreviewExposureViaMachineRpc,
        copyPublicPreviewUrl: copyLocalServicePublicPreviewUrlViaMachineRpc,
        executeLocalServiceAction: input.localServices?.executeLocalServiceAction ?? executeLocalServiceActionViaMachineRpc,
        fallback: computer,
    });
    return createBrowserRuntimeActionExecutor({
        ...(input.browserControl ? { control: input.browserControl } : {}),
        ...(!input.browserControl
            ? {
                resolveControl: (command) => {
                    const browserSessionId = resolveBrowserCommandSessionId(command);
                    return browserSessionId ? readRegisteredBrowserRuntimeControlAdapter(browserSessionId,
                        command.kind === 'openView' ? undefined : command.viewId) : null;
                },
            }
            : {}),
        ...(input.browserAutomation ? { automation: input.browserAutomation } : {}),
        ...(!input.browserAutomation ? { resolveAutomation: (request) => readRegisteredBrowserRuntimeAutomationAdapter(request.browserSessionId, request.viewId) } : {}),
        // BRW-15 attach-to-composer leaf: resolve the registered recording-attach owner so the
        // `browser.recording.attachToComposer` action dispatches a real attach (fail-closed when
        // no owner is registered).
        resolveRecordingAttach: () => readRegisteredBrowserRecordingAttachAdapter(),
        // Phase 4.2 annotation family: resolve the registered in-app annotation owner (the
        // BrowserShell host) so every `browser.context.annotation.*` action dispatches a real
        // state mutation through the front door (fail-closed when no host is mounted).
        resolveAnnotation: (input) => readRegisteredBrowserContextAnnotationAdapter(input),
        fallback: localServices,
    });
}

import type { SessionAttachMetadataIdentityPolicy } from '@happier-dev/protocol';

import type { AgentState, MachineMetadata, Metadata } from '@/api/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import {
    initializeBackendRunSession,
    type InitializeBackendRunSessionOptions,
} from '@/agent/runtime/initializeBackendRunSession';
import type { Credentials } from '@/persistence';
import { configuration } from '@/configuration';
import { DeferredApiSessionClient } from './DeferredApiSessionClient';
import type {
    DeferredStartupBootstrapResult,
    DeferredStartupPushSender,
} from './deferredStartupTypes';

type DeferredStartupBootstrapDeps = Readonly<{
    initializeBackendApiContextFn?: typeof initializeBackendApiContext;
    initializeBackendRunSessionFn?: typeof initializeBackendRunSession;
}>;

const DEFAULT_BACKGROUND_START_FAILURE_MESSAGE =
    '[startup-background-error] Failed to initialize Happy session in the background. Local mode may continue, but remote sync/switching could be unavailable.';

function createDeferredPushSenderProxy(ref: { current: DeferredStartupPushSender | null }): DeferredStartupPushSender {
    return Object.freeze({
        sendToAllDevices: (...args: Parameters<DeferredStartupPushSender['sendToAllDevices']>) => {
            const pushSender = ref.current;
            if (!pushSender) return;
            pushSender.sendToAllDevices(...args);
        },
        sendToAllDevicesAsync: async (...args: Parameters<DeferredStartupPushSender['sendToAllDevicesAsync']>) => {
            const pushSender = ref.current;
            if (!pushSender) return;
            await pushSender.sendToAllDevicesAsync(...args);
        },
    });
}

export async function createDeferredStartupBootstrap(params: Readonly<{
    credentials: Credentials;
    startedBy: 'terminal' | 'daemon';
    initialMachineId: string;
    machineMetadata: MachineMetadata;
    missingMachineIdMessage?: string;
    sessionTag: string;
    existingSessionId?: string;
    attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy | null;
    initialMetadata: Metadata;
    createInitializedSessionMetadata: (machineId: string) => Readonly<{
        metadata: Metadata;
        state: AgentState;
    }>;
    uiLogPrefix: string;
    startupMetadataOverrides: InitializeBackendRunSessionOptions['startupMetadataOverrides'];
    startupSideEffectsOrder?: InitializeBackendRunSessionOptions['startupSideEffectsOrder'];
    allowOfflineStub?: boolean;
    backgroundStartFailureMessage?: string;
    onBackgroundStartFailure?: (error: unknown) => void | Promise<void>;
    onSessionAttached?: (params: Readonly<{
        session: ApiSessionClient;
        machineId: string;
    }>) => void | Promise<void>;
    onPushSenderReady?: ((pushSender: DeferredStartupPushSender) => void | Promise<void>) | null;
    deps?: DeferredStartupBootstrapDeps;
}>): Promise<DeferredStartupBootstrapResult> {
    const initializeBackendApiContextFn = params.deps?.initializeBackendApiContextFn ?? initializeBackendApiContext;
    const initializeBackendRunSessionFn = params.deps?.initializeBackendRunSessionFn ?? initializeBackendRunSession;
    const backgroundController = new AbortController();
    const initialMetadata = {
        ...params.initialMetadata,
        machineId: params.initialMachineId,
    } satisfies Metadata;
    const deferredSession = new DeferredApiSessionClient({
        placeholderSessionId: `PID-${process.pid}`,
        limits: {
            maxEntries: configuration.startupDeferredSessionBufferMaxEntries,
            maxBytes: configuration.startupDeferredSessionBufferMaxBytes,
        },
    });
    const pushSenderRef = { current: null as DeferredStartupPushSender | null };
    const deferredPushSender = createDeferredPushSenderProxy(pushSenderRef);
    const reconnectionHandleRef = { current: null as { cancel: () => void } | null };
    let started = false;

    const attachServerSession = async (args: Readonly<{
        session: ApiSessionClient;
        machineId: string;
    }>): Promise<void> => {
        await deferredSession.attach(args.session as Parameters<DeferredApiSessionClient['attach']>[0]);
        await params.onSessionAttached?.(args);
        const pushSender = pushSenderRef.current;
        if (pushSender) {
            await params.onPushSenderReady?.(pushSender);
        }
    };

    const start = async (): Promise<void> => {
        if (started) return;
        started = true;

        if (backgroundController.signal.aborted) {
            return;
        }

        try {
            const initializedApiContext = await initializeBackendApiContextFn({
                credentials: params.credentials,
                machineMetadata: params.machineMetadata,
                missingMachineIdMessage: params.missingMachineIdMessage,
                skipMachineRegistration: params.startedBy === 'daemon',
            });
            pushSenderRef.current = initializedApiContext.api.push();

            const initializedSessionMetadata = params.createInitializedSessionMetadata(initializedApiContext.machineId);
            const initializedSession = await initializeBackendRunSessionFn({
                api: initializedApiContext.api,
                sessionTag: params.sessionTag,
                metadata: initializedSessionMetadata.metadata,
                state: initializedSessionMetadata.state,
                existingSessionId: params.existingSessionId,
                attachMetadataIdentityPolicy: params.attachMetadataIdentityPolicy,
                uiLogPrefix: params.uiLogPrefix,
                offlineNotify: (message: string) => {
                    deferredSession.sendSessionEvent({ type: 'message', message });
                },
                startupMetadataOverrides: params.startupMetadataOverrides,
                allowOfflineStub: params.allowOfflineStub,
                startupSideEffectsOrder: params.startupSideEffectsOrder,
                onSessionSwap: async (nextSession) => {
                    await attachServerSession({
                        session: nextSession,
                        machineId: initializedApiContext.machineId,
                    });
                },
            });
            reconnectionHandleRef.current = initializedSession.reconnectionHandle;

            if (backgroundController.signal.aborted) {
                initializedSession.reconnectionHandle?.cancel();
                return;
            }

            if (!initializedSession.reportedSessionId) {
                deferredSession.sendSessionEvent({
                    type: 'message',
                    message: 'Server unreachable — continuing in local-only mode.',
                });
                return;
            }

            await attachServerSession({
                session: initializedSession.session,
                machineId: initializedApiContext.machineId,
            });
        } catch (error) {
            try {
                await params.onBackgroundStartFailure?.(error);
            } catch {
                // ignore
            }
            deferredSession.sendSessionEvent({
                type: 'message',
                message: params.backgroundStartFailureMessage ?? DEFAULT_BACKGROUND_START_FAILURE_MESSAGE,
            });
        }
    };

    return {
        api: {
            push: () => deferredPushSender,
        },
        session: deferredSession as unknown as ApiSessionClient,
        machineId: params.initialMachineId,
        metadata: initialMetadata,
        attachedToExistingSession: Boolean(params.existingSessionId),
        reconnectionHandle: {
            cancel: () => {
                reconnectionHandleRef.current?.cancel();
            },
        },
        start,
        cleanup: async () => {
            backgroundController.abort();
            reconnectionHandleRef.current?.cancel();
            deferredSession.cancel();
        },
    };
}

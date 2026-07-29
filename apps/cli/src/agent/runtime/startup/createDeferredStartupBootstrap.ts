import type { SessionAttachMetadataIdentityPolicy } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { AgentState, MachineMetadata, Metadata } from '@/api/types';
import type {
    ApiSessionClient,
    ApiSessionClientOptions,
} from '@/api/session/sessionClient';
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
    DeferredStartupRegisteredStateMutationFactory,
    DeferredStartupStartOptions,
} from './deferredStartupTypes';

type DeferredStartupBootstrapDeps = Readonly<{
    initializeBackendApiContextFn?: typeof initializeBackendApiContext;
    initializeBackendRunSessionFn?: typeof initializeBackendRunSession;
}>;

const DEFAULT_BACKGROUND_START_FAILURE_MESSAGE =
    '[startup-background-error] Failed to initialize Happy session in the background. Local mode may continue, but remote sync/switching could be unavailable.';

class DeferredStartupAuthorityAttachFailure extends Error {
    readonly failure: unknown;

    constructor(failure: unknown) {
        super('Deferred startup session authority attachment failed');
        this.name = 'DeferredStartupAuthorityAttachFailure';
        this.failure = failure;
    }
}

class DeferredStartupCancelled extends Error {
    constructor() {
        super('Deferred startup cancelled');
        this.name = 'DeferredStartupCancelled';
    }
}

function awaitStartupAbortable<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    onCancelledValue?: (value: T) => void | Promise<void>,
): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(new DeferredStartupCancelled());
    }
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const settle = (callback: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            callback();
        };
        const onAbort = () => {
            settle(() => reject(new DeferredStartupCancelled()));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void promise.then(
            (value) => {
                if (settled) {
                    void Promise.resolve(onCancelledValue?.(value)).catch(() => undefined);
                    return;
                }
                settle(() => resolve(value));
            },
            (error: unknown) => settle(() => reject(error)),
        );
    });
}

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
    sessionAttachFilePath?: string;
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
    createInitialRegisteredSessionStateFieldMutations?: DeferredStartupRegisteredStateMutationFactory;
    transformSessionInputBeforeCommit?: ApiSessionClientOptions['transformSessionInputBeforeCommit'];
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
    }>, startOptions?: DeferredStartupStartOptions): Promise<void> => {
        try {
            await deferredSession.attach(
                args.session as Parameters<DeferredApiSessionClient['attach']>[0],
                {
                    beforeBufferedDrain: async () => {
                        await startOptions?.prepareSession?.(args.session);
                    },
                },
            );
        } catch (error) {
            try {
                args.session.deactivateDurableMutationDelivery();
            } catch {
                // Preserve the authority-preparation failure as the startup rejection.
            }
            await args.session.close().catch(() => undefined);
            throw new DeferredStartupAuthorityAttachFailure(error);
        }
        await params.onSessionAttached?.(args);
        const pushSender = pushSenderRef.current;
        if (pushSender) {
            await params.onPushSenderReady?.(pushSender);
        }
    };

    const start = async (
        startOptions: DeferredStartupStartOptions = {},
    ): Promise<void> => {
        if (started) return;
        started = true;

        if (backgroundController.signal.aborted) {
            return;
        }

        try {
            const initializedApiContext = await awaitStartupAbortable(
                initializeBackendApiContextFn({
                    credentials: params.credentials,
                    machineMetadata: params.machineMetadata,
                    missingMachineIdMessage: params.missingMachineIdMessage,
                    skipMachineRegistration: params.startedBy === 'daemon',
                }),
                backgroundController.signal,
            );
            if (backgroundController.signal.aborted) {
                return;
            }
            pushSenderRef.current = initializedApiContext.api.push();
            const runtimeSessionApi: Pick<
                ApiClient,
                'getOrCreateSession' | 'sessionSyncClient'
            > = {
                getOrCreateSession: (options) =>
                    initializedApiContext.api.getOrCreateSession(options),
                sessionSyncClient: (sessionRow) =>
                    initializedApiContext.api.sessionSyncClient(sessionRow, {
                        initialRegisteredSessionStateFieldMutations:
                            params.createInitialRegisteredSessionStateFieldMutations?.(
                                sessionRow.id,
                            ) ?? [],
                        durableMutationDeliveryInitiallyActive: false,
                        transformSessionInputBeforeCommit:
                            params.transformSessionInputBeforeCommit,
                    }),
            };

            const initializedSessionMetadata = params.createInitializedSessionMetadata(initializedApiContext.machineId);
            const initializedSession = await awaitStartupAbortable(
                initializeBackendRunSessionFn({
                    api: runtimeSessionApi,
                    sessionTag: params.sessionTag,
                    metadata: initializedSessionMetadata.metadata,
                    state: initializedSessionMetadata.state,
                    existingSessionId: params.existingSessionId,
                    ...(params.sessionAttachFilePath
                        ? { sessionAttachFilePath: params.sessionAttachFilePath }
                        : {}),
                    attachMetadataIdentityPolicy: params.attachMetadataIdentityPolicy,
                    uiLogPrefix: params.uiLogPrefix,
                    offlineNotify: (message: string) => {
                        deferredSession.sendSessionEvent({ type: 'message', message });
                    },
                    startupMetadataOverrides: params.startupMetadataOverrides,
                    allowOfflineStub: params.allowOfflineStub,
                    startupSideEffectsOrder: params.startupSideEffectsOrder,
                    signal: backgroundController.signal,
                    onSessionSwap: async (nextSession) => {
                        await attachServerSession({
                            session: nextSession,
                            machineId: initializedApiContext.machineId,
                        }, startOptions);
                    },
                }),
                backgroundController.signal,
                async (initializedSession) => {
                    try {
                        initializedSession.reconnectionHandle?.cancel();
                    } catch {
                        // A late cancelled startup result has no active owner; still close its session.
                    }
                    await initializedSession.session.close().catch(() => undefined);
                },
            );
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
            }, startOptions);
        } catch (error) {
            if (error instanceof DeferredStartupCancelled) {
                return;
            }
            if (error instanceof DeferredStartupAuthorityAttachFailure) {
                throw error.failure;
            }
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

    const cancel = () => {
        backgroundController.abort();
        reconnectionHandleRef.current?.cancel();
        deferredSession.cancel();
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
        cancel,
        cleanup: async () => {
            cancel();
        },
    };
}

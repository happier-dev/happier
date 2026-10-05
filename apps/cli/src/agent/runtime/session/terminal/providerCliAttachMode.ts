import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { HostTerminalOrchestration } from './contract';
import { createTerminalRuntimeSwitchHandlerService } from './switchHandler';
import type { HostSessionTerminalRemoteModeLoop } from '@/agent/runtime/session/loop/terminalRemoteModeRuntime';
import type { RuntimeTurnOperations, RuntimeTurnDisposeReason, RuntimeTurnSessionOpenIntent } from '@/agent/runtime/turns/runtimeTurnOperations';
import { createAgentRuntimeSwitchState } from '@/agent/runtime/mode/switching/createSwitchState';
import type { HostProviderCliAttachSurface, HostProviderCliAttachRequest } from '@/session/attach/providerCliAttach';
import { logger } from '@/ui/logger';
import { SessionProviderCliAttachPrepareRequestV1Schema, SessionTerminalMetadataSchema,
    type SessionProviderCliAttachPrepareRequestV1, type SessionProviderCliAttachPrepareResultV1 } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { configuration } from '@/configuration';
import { createHerdrClient, type HerdrClient } from '@/integrations/herdr/client';
import { HERDR_ACTION_TIMEOUT_MS, HERDR_STARTUP_TIMEOUT_MS } from '@/integrations/herdr/runtimeBinary';
import { createTerminalAttachmentId, readTerminalHostAttachmentState, terminalMetadataMatchesHostHandle,
    writeTerminalHostAttachmentInfo, type BorrowedTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { executeTerminalHostDisposition } from '@/terminal/attachment/terminalHostDisposition';
import { proveTerminalClientCustody } from '@/terminal/host/terminalClientCustody';
import { buildTerminalHostHandleFromMetadata } from '@/terminal/runtime/terminalMetadata';
import { clearTerminalControlServiceabilityProjection } from '@/daemon/startup/terminalControlServiceabilityProjection';
import { reportSessionToDaemonIfRunning } from '@/agent/runtime/startupSideEffects';
import { publishNativeAgentTerminalHostBinding } from './terminalHostBinding';

export function waitForNativeAgentTerminalRemoteDisposition(params: Readonly<{
    signal: AbortSignal;
    switching: HostTerminalOrchestration['switching'] | null;
    requestLocal?: () => Promise<boolean>;
}>): Promise<'switch' | 'exit'> {
    if (params.signal.aborted) return Promise.resolve('exit');
    if (!params.switching) {
        return new Promise((resolve) => {
            params.signal.addEventListener(
                'abort',
                () => resolve('exit'),
                { once: true },
            );
        });
    }
    const switching = params.switching;
    return new Promise((resolve, reject) => {
        let settled = false;
        let subscription: ReturnType<
            HostTerminalOrchestration['switching']['register']
        > | null = null;
        const settle = (result: 'switch' | 'exit') => {
            if (settled) return;
            settled = true;
            params.signal.removeEventListener('abort', onAbort);
            subscription?.unsubscribe();
            subscription = null;
            resolve(result);
        };
        const onAbort = () => settle('exit');
        try {
            subscription = switching.register(async (request) => {
                if (request.target === 'remote') return true;
                if (request.target !== 'local') return false;
                const receipt = params.requestLocal?.();
                settle('switch');
                return receipt ? await receipt : true;
            });
        } catch (error) {
            reject(error);
            return;
        }
        params.signal.addEventListener('abort', onAbort, { once: true });
        if (params.signal.aborted) settle('exit');
    });
}

export function createNativeAgentProviderAttachModeBinding<TRuntime extends RuntimeTurnOperations>(params: Readonly<{
    runtime: TRuntime;
    attach: HostProviderCliAttachSurface;
    session: ApiSessionClient;
    topology: 'exclusive' | 'shared';
    remoteWritable: boolean;
    startingMode: 'terminal' | 'remote';
    generationSignal?: AbortSignal;
    resolveManagedServiceAccess?: HostProviderCliAttachRequest['resolveManagedServiceAccess'];
    hostPresentation?: HostProviderCliAttachRequest['hostPresentation'];
    disposePresentation?(): Promise<void>;
    readPresentationAttachmentId?(): string | undefined;
    agentId: string;
    reportSessionMetadataToDaemon?: typeof reportSessionToDaemonIfRunning;
}>): Readonly<{
    runtime: TRuntime;
    terminalRemoteModeLoop: HostSessionTerminalRemoteModeLoop;
}> {
    const prepareTerminalPresentation = params.runtime.prepareTerminalPresentation;
    if (!prepareTerminalPresentation) {
        throw new Error('Provider CLI attach preparation is unavailable');
    }
    const lifecycleAbortController = new AbortController();
    let activeAttach: Promise<unknown> | null = null;
    const lifecycleSignal = AbortSignal.any([
        lifecycleAbortController.signal,
        ...(params.generationSignal ? [params.generationSignal] : []),
    ]);
    const switching = createTerminalRuntimeSwitchHandlerService({
        registerHandler: params.session.rpcHandlerManager.registerHandler.bind(
            params.session.rpcHandlerManager,
        ),
    });
    let pendingLocalRestore: Readonly<{ promise: Promise<boolean>; complete(value: boolean): void }> | null = null;
    const beginLocalRestore = () => {
        if (pendingLocalRestore) return pendingLocalRestore;
        let complete!: (value: boolean) => void;
        const promise = new Promise<boolean>((resolve) => { complete = resolve; });
        pendingLocalRestore = { promise, complete };
        return pendingLocalRestore;
    };
    const completeLocalRestore = (value: boolean) => {
        pendingLocalRestore?.complete(value);
        pendingLocalRestore = null;
    };
    lifecycleSignal.addEventListener('abort', () => completeLocalRestore(false), { once: true });
    const publishAttached = async (attached: boolean, expectedAttachmentId = externalClient?.attachmentInfo.attachmentId ?? params.readPresentationAttachmentId?.()): Promise<void> => {
        if (!attached && expectedAttachmentId
            && params.session.getMetadataSnapshot()?.terminal?.controlServiceabilityV1?.attachmentId !== expectedAttachmentId) return;
        await params.session.updateAgentState((current) => ({
            ...current,
            controlledByUser: false,
            localControl: createAgentRuntimeSwitchState({
                attached,
                topology: params.topology,
                canAttach: true,
                canDetach: attached,
                remoteWritable: params.remoteWritable,
            }),
        }));
    };
    type Observation = NonNullable<SessionProviderCliAttachPrepareRequestV1['terminalClient']>;
    type ExternalClient = Readonly<{ observation: Observation; attachmentInfo: BorrowedTerminalHostAttachmentInfo;
        retired: Promise<void>; completeRetirement(): void;
        retirement: { requested: boolean; completion: Promise<void> | null } }>;
    let externalClient: ExternalClient | null = null;
    let clientAdmission: Promise<SessionProviderCliAttachPrepareResultV1> | null = null;
    const reportMetadata = params.reportSessionMetadataToDaemon ?? reportSessionToDaemonIfRunning;
    const onMetadataUpdated = () => {
        const current = externalClient;
        const control = params.session.getMetadataSnapshot()?.terminal?.controlServiceabilityV1;
        if (!current || current.retirement.requested || control?.retired !== true
            || control.attachmentId !== current.attachmentInfo.attachmentId) return;
        if (externalClient === current) externalClient = null;
        current.completeRetirement();
    };
    params.session.on('metadata-updated', onMetadataUpdated);
    const retireExternalClient = async (): Promise<void> => {
        const current = externalClient;
        if (!current) return;
        if (current.retirement.completion) return await current.retirement.completion;
        current.retirement.requested = true;
        const completion = (async () => {
            const result = await executeTerminalHostDisposition({ happyHomeDir: configuration.happyHomeDir,
                sessionId: params.session.sessionId, expectedAttachmentId: current.attachmentInfo.attachmentId,
                expectedAttachmentInfo: current.attachmentInfo,
                intent: { kind: 'release_borrowed_host', reason: 'explicit_user_stop' },
                beforeDescriptorRetirement: async () => {
                    await params.session.updateMetadata(metadata => {
                        const retired = clearTerminalControlServiceabilityProjection({ metadata,
                            retiredAttachmentId: current.attachmentInfo.attachmentId, retiredAt: Date.now(), terminalMode: 'herdr' });
                        return retired === metadata ? metadata : { ...metadata, terminal: SessionTerminalMetadataSchema.parse(retired.terminal) };
                    });
                    const metadata = params.session.getMetadataSnapshot();
                    if (metadata) await reportMetadata({ sessionId: params.session.sessionId, metadata });
                },
            });
            if (result.status !== 'retired') throw new Error('Borrowed native client cleanup is incomplete');
            if (externalClient === current) externalClient = null;
            current.completeRetirement();
        })();
        current.retirement.completion = completion;
        try { await completion; }
        finally { if (current.retirement.completion === completion) current.retirement.completion = null; }
    };
    const sameObservation = (left: Observation, right: Observation) =>
        left.herdr.sessionName === right.herdr.sessionName && left.herdr.socketPath === right.herdr.socketPath
        && left.herdr.paneId === right.herdr.paneId && left.herdr.terminalId === right.herdr.terminalId
        && left.launcher.pid === right.launcher.pid
        && left.launcher.processInstanceFingerprint === right.launcher.processInstanceFingerprint;
    const admitTerminalClient = async (request: SessionProviderCliAttachPrepareRequestV1,
        presentation: Extract<Awaited<ReturnType<typeof prepareTerminalPresentation>>, { kind: 'provider_attach' }>): Promise<SessionProviderCliAttachPrepareResultV1> => {
        const observation = request.terminalClient!;
        const reject = (phase: string): SessionProviderCliAttachPrepareResultV1 => {
            logger.infoFile('[native-agent] Restored native client admission refused', {
                error: 'terminal_native_client_admission_refused', phase, sessionId: params.session.sessionId,
            });
            return { ok: false, errorCode: phase };
        };
        const isCurrent = () => !lifecycleSignal.aborted && params.runtime.readSessionIdentity().sessionId === request.providerSessionId;
        if (params.topology !== 'shared') return reject('managed_client_not_supported');
        if (!observation.attached) {
            if (!externalClient || !sameObservation(externalClient.observation, observation)) return reject('stale_release');
            await retireExternalClient();
            return { ok: true, providerSessionId: request.providerSessionId };
        }
        if (externalClient) return sameObservation(externalClient.observation, observation)
            ? { ok: true, providerSessionId: request.providerSessionId } : reject('borrowed_client_replacement');
        if (activeAttach) return reject('native_presentation_active');
        const target = { happyHomeDir: configuration.happyHomeDir, sessionId: params.session.sessionId };
        const old = await readTerminalHostAttachmentState(target);
        const oldInfo = old.status === 'present' && old.info.version !== 1 ? old.info : null;
        if (old.status === 'unreadable' || (old.status === 'present' && (!oldInfo || oldInfo.handle.kind !== 'herdr'))) return reject('local_descriptor_unavailable');
        const oldTerminal = params.session.getMetadataSnapshot()?.terminal;
        const retired = oldTerminal?.controlServiceabilityV1;
        if (!oldInfo && (!oldTerminal || retired?.retired !== true || retired.reason !== 'attachment_retired'
            || !retired.attachmentId?.trim())) return reject('retired_placement_unavailable');
        const oldHandle = oldInfo?.handle ?? (oldTerminal ? buildTerminalHostHandleFromMetadata(oldTerminal) : null);
        const geometry = observation.herdr;
        if (!oldHandle || oldHandle.kind !== 'herdr' || oldHandle.sessionName !== geometry.sessionName
            || oldHandle.socketPath !== geometry.socketPath || oldHandle.paneId !== geometry.paneId) return reject('recorded_placement_mismatch');
        // These are exact-socket API operations only; no server/binary is spawned.
        const client: HerdrClient = createHerdrClient({ binary: 'herdr', sessionName: geometry.sessionName,
            socketPath: geometry.socketPath, actionTimeoutMs: HERDR_ACTION_TIMEOUT_MS, startupTimeoutMs: HERDR_STARTUP_TIMEOUT_MS });
        await client.assertServerVersion();
        const pane = await client.getPane(geometry.paneId);
        if (pane.paneId !== geometry.paneId || pane.terminalId !== geometry.terminalId) return reject('current_pane_mismatch');
        const reusingRetiredPane = !oldInfo && oldHandle.terminalId === geometry.terminalId;
        if (!oldHandle.terminalId || (!reusingRetiredPane
            && (oldHandle.terminalId === geometry.terminalId || await client.findPane(oldHandle.terminalId)))) return reject('previous_host_alive');
        if (oldInfo?.version === 3 && oldInfo.nativeClientProcess) return reject('previous_native_client_custody');
        const prepared = await params.attach.prepareInvocation({ sessionId: params.session.sessionId,
            metadata: presentation.metadata, signal: lifecycleSignal,
            ...(params.resolveManagedServiceAccess ? { resolveManagedServiceAccess: params.resolveManagedServiceAccess } : {}),
        });
        if (!prepared.ok) return reject('native_invocation_unavailable');
        if (!await proveTerminalClientCustody({ launcher: observation.launcher,
            processes: await client.processInfo(pane.paneId), invocation: prepared.value.invocation })) return reject('native_process_custody');
        const current = await readTerminalHostAttachmentState(target);
        if (oldInfo) {
            if (current.status !== 'present' || current.info.version !== oldInfo.version
                || current.info.attachmentId !== oldInfo.attachmentId || JSON.stringify(current.info.handle) !== JSON.stringify(oldInfo.handle)) return reject('local_descriptor_changed');
            if (current.info.version === 3 && current.info.nativeClientProcess) return reject('local_descriptor_changed');
        } else {
            const terminal = params.session.getMetadataSnapshot()?.terminal;
            if (current.status !== 'absent' || !terminal || !terminalMetadataMatchesHostHandle(terminal, oldHandle)
                || terminal.herdr?.paneId !== oldHandle.paneId || terminal.controlServiceabilityV1?.attachmentId !== retired?.attachmentId
                || terminal.controlServiceabilityV1?.retired !== true) return reject('retired_placement_changed');
        }
        if (!isCurrent() || prepared.value.managedServiceAccess?.isCurrent?.() === false) return reject('native_identity_changed');
        if (oldInfo) {
            const result = await executeTerminalHostDisposition({ ...target, expectedAttachmentId: oldInfo.attachmentId,
                intent: oldInfo.version === 3 ? { kind: 'release_borrowed_host', reason: 'wrapper_exit' }
                    : { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' } });
            if (result.status !== 'retired') return reject('previous_descriptor_retirement_incomplete');
        }
        const attachmentInfo = await writeTerminalHostAttachmentInfo({ ...target, lifecycle: 'borrowed',
            nativeClientProcess: observation.launcher, handle: { kind: 'herdr', ...geometry, attachmentId: createTerminalAttachmentId(),
                attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' } } });
        if (attachmentInfo.version !== 3) return reject('bound_client_descriptor_unavailable');
        let completeRetirement!: () => void;
        const resource: ExternalClient = { observation, attachmentInfo,
            retired: new Promise<void>(resolve => { completeRetirement = resolve; }),
            completeRetirement: () => completeRetirement(), retirement: { requested: false, completion: null } };
        externalClient = resource;
        if (!isCurrent()) { await retireExternalClient(); return reject('native_identity_changed'); }
        await publishNativeAgentTerminalHostBinding({ session: params.session, handle: attachmentInfo.handle,
            agentId: params.agentId, reportSessionMetadataToDaemon: reportMetadata,
            herdrClient: client });
        if (!isCurrent()) {
            await retireExternalClient();
            return reject('native_identity_changed');
        }
        return { ok: true, providerSessionId: request.providerSessionId };
    };
    params.session.rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_PROVIDER_CLI_ATTACH_PREPARE,
        async (input: unknown): Promise<SessionProviderCliAttachPrepareResultV1> => {
            const parsed = SessionProviderCliAttachPrepareRequestV1Schema.safeParse(input);
            if (!parsed.success) return { ok: false, errorCode: 'invalid_input' };
            const request = parsed.data;
            if (lifecycleSignal.aborted || params.runtime.readSessionIdentity().sessionId !== request.providerSessionId) {
                return { ok: false, errorCode: 'native_session_changed' };
            }
            const presentation = await prepareTerminalPresentation();
            if (lifecycleSignal.aborted || presentation.kind !== 'provider_attach'
                || params.runtime.readSessionIdentity().sessionId !== request.providerSessionId) {
                return { ok: false, errorCode: 'native_session_changed' };
            }
            if (request.terminalClient) {
                if (clientAdmission) return { ok: false, errorCode: 'terminal_client_admission_in_progress' };
                const admission = admitTerminalClient(request, presentation);
                clientAdmission = admission;
                let result: SessionProviderCliAttachPrepareResultV1;
                try { result = await admission; }
                finally { if (clientAdmission === admission) clientAdmission = null; }
                // The admission owns proof and binding, not the mode receipt:
                // runTerminal must be able to join it before completing Switch.
                if (result.ok && request.terminalClient.attached
                    && await params.session.rpcHandlerManager.invokeLocal('switch', { to: 'local' }) !== true) {
                    await retireExternalClient();
                    logger.infoFile('[native-agent] Restored native client admission refused', {
                        error: 'terminal_native_client_admission_refused', phase: 'native_mode_unavailable', sessionId: params.session.sessionId,
                    });
                    return { ok: false, errorCode: 'native_mode_unavailable' };
                }
                return result;
            }
            return { ok: true, providerSessionId: request.providerSessionId };
        });
    const modeLoop: HostSessionTerminalRemoteModeLoop = Object.freeze({
        startingMode: params.startingMode,
        remoteExitCode: 0,
        topology: params.topology,
        remoteWritable: params.remoteWritable,
        ownsCurrentTerminalDisplay: true,
        async runTerminal() {
            let presentationAttachmentId = externalClient?.attachmentInfo.attachmentId ?? params.readPresentationAttachmentId?.();
            const receipt = beginLocalRestore();
            activeAttach = receipt.promise;
            let attached = false;
            const localAbortController = new AbortController();
            const signal = AbortSignal.any([
                lifecycleSignal,
                localAbortController.signal,
            ]);
            const switchBinding = switching.register(async (request) => {
                if (request.target === 'local') return attached ? true : await receipt.promise;
                if (request.target !== 'remote') return false;
                // Admission may still be proving the external client. Join its
                // binding before retiring custody, never ACK an empty snapshot.
                await clientAdmission;
                if (externalClient) await retireExternalClient();
                completeLocalRestore(false);
                localAbortController.abort();
                return true;
            });
            try {
                if (clientAdmission && !(await clientAdmission).ok) {
                    throw new Error('Restored native client admission did not complete');
                }
                presentationAttachmentId = externalClient?.attachmentInfo.attachmentId ?? params.readPresentationAttachmentId?.();
                if (externalClient) {
                    const resource = externalClient;
                    if (!signal.aborted && !resource.retirement.requested) {
                        await publishAttached(true);
                        // Detach can claim the resource while state publication
                        // awaits its ACK. Its retirement must win that receipt.
                        if (!signal.aborted && externalClient === resource && !resource.retirement.requested) {
                            attached = true;
                            completeLocalRestore(true);
                        }
                    }
                    if (signal.aborted && externalClient === resource) await retireExternalClient();
                    activeAttach = resource.retired;
                    await resource.retired;
                    return lifecycleSignal.aborted ? { type: 'exit' as const, code: 0 } : { type: 'switch' as const };
                }
                const presentation = await prepareTerminalPresentation();
                if (presentation.kind !== 'provider_attach') {
                    throw new Error('The active Session does not prepare a provider CLI attachment');
                }
                if (signal.aborted) {
                    return lifecycleSignal.aborted
                        ? { type: 'exit' as const, code: 0 }
                        : { type: 'switch' as const };
                }
                const attaching = params.attach.attachManaged({
                    sessionId: params.session.sessionId,
                    metadata: presentation.metadata,
                    signal,
                    ...(params.hostPresentation ? { hostPresentation: params.hostPresentation } : {}),
                    ...(params.resolveManagedServiceAccess
                        ? { resolveManagedServiceAccess: params.resolveManagedServiceAccess }
                        : {}),
                    onAttached: async () => {
                        signal.throwIfAborted();
                        await publishAttached(true);
                        signal.throwIfAborted();
                        attached = true;
                        completeLocalRestore(true);
                    },
                });
                activeAttach = Promise.resolve(attaching);
                const result = await attaching;
                if (!result.ok) {
                    throw new Error(result.message);
                }
                if (!attached && !signal.aborted) {
                    throw new Error('Managed provider attach ended before native startup');
                }
                return lifecycleSignal.aborted
                    ? { type: 'exit' as const, code: result.value.exitCode ?? 0 }
                    : { type: 'switch' as const };
            } catch (error) {
                if (lifecycleSignal.aborted) return { type: 'exit' as const, code: 0 };
                if (localAbortController.signal.aborted) return { type: 'switch' as const };
                // The Session runtime is already admitted. A missing optional client
                // must leave the same remote Session usable, including initial presentation.
                logger.infoFile('[native-agent] Managed terminal restoration failed; retaining remote Session', {
                    error: 'managed_provider_attach_startup_failed', sessionId: params.session.sessionId,
                });
                return { type: 'switch' as const };
            } finally {
                activeAttach = null;
                completeLocalRestore(false);
                switchBinding.unsubscribe();
                await publishAttached(false, presentationAttachmentId);
            }
        },
        async runRemote() {
            await publishAttached(false);
            return await waitForNativeAgentTerminalRemoteDisposition({
                signal: lifecycleSignal,
                switching,
                requestLocal: () => beginLocalRestore().promise,
            });
        },
        onModeChange: () => undefined,
    });
    const runtime = Object.freeze({
        ...params.runtime,
        async resetOrDisposeRuntime(
            reason?: RuntimeTurnDisposeReason,
            nextSessionOpenIntent?: RuntimeTurnSessionOpenIntent,
        ) {
            lifecycleAbortController.abort();
            await retireExternalClient();
            await clientAdmission;
            await activeAttach;
            params.session.off('metadata-updated', onMetadataUpdated);
            await params.disposePresentation?.();
            await params.runtime.resetOrDisposeRuntime(
                reason,
                nextSessionOpenIntent,
            );
        },
    });
    return Object.freeze({ runtime, terminalRemoteModeLoop: modeLoop });
}

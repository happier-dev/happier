import * as React from 'react';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { TERMINAL_STREAM_MAX_READ_BYTES } from '@happier-dev/protocol/terminal/stream';
import type { DaemonTerminalLaunchIntent } from '@happier-dev/protocol/daemon/terminal';
import type { WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { EmbeddedTerminalPaneStatus } from '@/components/terminal/embedded/types';

import { createEmptyTerminalSurfaceState, readTerminalSurfaceState, type TerminalSurfaceState } from '@/components/sessions/terminal/terminalSurfaceStateCache';
import { resolveTerminalAdmissionErrorCode } from '@/components/sessions/terminal/terminalErrorCopy';
import {
    isRecoverableTerminalRpcError,
    isRecoverableTerminalSessionErrorCode,
    resolveTerminalAutoRetryDelayMs,
    safeTimeoutClear,
    safeTimeoutSet,
    TERMINAL_AUTO_RETRY_MAX_ATTEMPTS,
} from '@/components/sessions/terminal/terminalRpcRecovery';
import { useEmbeddedTerminalTransportHandlers } from '@/components/sessions/terminal/useEmbeddedTerminalTransportHandlers';
import { useTerminalSurfaceState } from '@/components/sessions/terminal/useTerminalSurfaceState';
import type {
    EmbeddedTerminalRendererHandle,
    EmbeddedTerminalWriteCompleteEvent,
} from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { resolveTerminalHyperlinkAction } from '@/components/terminal/interaction/links';
import {
    applyEmbeddedTerminalBellPolicy,
    applyEmbeddedTerminalTitlePolicy,
    sanitizeTerminalBell,
    sanitizeTerminalTitle,
} from '@/components/terminal/interaction/title';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    createMachineRpcTerminalStreamCarrier,
    readTerminalStreamInputErrorCode,
} from '@/sync/domains/terminal/stream/carrier';
import {
    createTerminalRendererAckDelivery,
    type TerminalRendererAckDelivery,
    type TerminalRendererAckDeliveryDiagnostic,
} from '@/sync/domains/terminal/stream/ackDelivery';
import {
    applyTerminalRendererAck,
    createTerminalStreamCreditState,
    type TerminalStreamCreditState,
} from '@/sync/domains/terminal/stream/credit';
import type {
    TerminalStreamCursor,
    TerminalStreamFrame,
} from '@/sync/domains/terminal/stream/model';
import { resolveTerminalReplayPlan } from '@/sync/domains/terminal/stream/replay';
import {
    createTerminalStreamRuntime,
    createTerminalUtf8ProjectionDecoder,
    TERMINAL_OUTPUT_GAP_MARKER,
    type TerminalStreamRuntime,
} from '@/sync/domains/terminal/stream/runtime';
import { machineTerminalClose } from '@/sync/ops/machineTerminal';
import { subscribeMachineRpcRecovery } from '@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery';
import { buildMachineTerminalSessionRequest } from './machineTerminalSessionRequest';
import { useMachineTerminalActionAdmission } from './useMachineTerminalActionAdmission';
import { delay } from '@/utils/timing/time';
import { useTerminalActionOperationState } from '@/sync/domains/actionOperations/useActionOperations';
import { refreshTerminalActionOperation } from '@/sync/domains/actionOperations/actionOperationRuntime';

export type TerminalStatus = EmbeddedTerminalPaneStatus;

const mutableTerminalRendererId = 'embedded-terminal';

type PendingRendererWrite = EmbeddedTerminalWriteCompleteEvent & Readonly<{
    previewBytes: Uint8Array;
    nextCursor: TerminalStreamCursor;
    deferredFrames: readonly TerminalStreamFrame[];
    responseCursor: TerminalStreamCursor;
    responseDone: boolean;
}>;

export function useMachineTerminalSession(params: Readonly<{
    machineId: string | null;
    serverId?: string | null;
    cwd: string | null;
    launch?: DaemonTerminalLaunchIntent | null;
    machineReachable?: boolean | null;
    machineRpcTargetAvailable?: boolean;
    terminalKey: string;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
    closeOnUnmount?: boolean;
    sessionId?: string;
    scopeId?: string;
    memberId?: string;
    workspace?: WorkspaceAddressV2;
    /** A borrowed view may read output, but never mutate its owning process. */
    readOnly?: boolean;
    /** An existing process owned by another lifecycle. Null waits for that owner;
     * undefined retains this controller's normal ensure/restart ownership. */
    attachedTerminalId?: string | null;
    onAttachedOutput?: (terminalId: string, preview: string) => void;
}>) {
    const rendererInstanceId = React.useId();
    const admission = useMachineTerminalActionAdmission({ terminalKey: params.terminalKey, workspace: params.workspace,
        machineId: params.machineId, serverId: params.serverId, scopeId: params.scopeId, memberId: params.memberId });
    const { workspace } = admission;
    const admissionRef = React.useRef(admission);
    const writeClipboard = useClipboardWrite(admission.lifetime?.scope ?? null);
    admissionRef.current = admission;
    const attachmentScopeRef = React.useRef<ServerAccountScope | null>(null);
    const embeddedTerminalRendererId = params.readOnly
        ? `embedded-terminal-view:${rendererInstanceId}`
        : mutableTerminalRendererId;
    const byteStreamEnabled = useFeatureEnabled(
        'terminal.transport.byteStream',
        params.serverId ? { scopeKind: 'spawn', serverId: params.serverId } : undefined,
    );
    const initialSurfaceState = React.useMemo(
        () => readTerminalSurfaceState(params.terminalKey) ?? createEmptyTerminalSurfaceState(),
        [params.terminalKey],
    );

    const retainedExit = params.readOnly && params.attachedTerminalId === initialSurfaceState.terminalId
        && admission.lifetime?.isCurrent() && areServerAccountScopesEqual(initialSurfaceState.exit?.scope, admission.lifetime.scope)
        ? initialSurfaceState.exit : undefined;
    const operationState = useTerminalActionOperationState({
        serverId: admission.lifetime?.isCurrent() ? admission.lifetime.scope.serverId : null,
        accountId: admission.lifetime?.isCurrent() ? admission.lifetime.scope.accountId : null,
        machineId: params.machineId,
        terminalId: params.readOnly ? params.attachedTerminalId ?? null : null,
    });
    const [status, setStatus] = React.useState<TerminalStatus>(() => retainedExit ? 'exited'
        : params.attachedTerminalId !== undefined || initialSurfaceState.terminalId ? 'connecting' : 'not-open');
    const [error, setError] = React.useState<string | null>(null);
    const [exitCode, setExitCode] = React.useState<number | null>(retainedExit?.exitCode ?? null);
    const [exitSignal, setExitSignal] = React.useState<number | null>(retainedExit?.signal ?? null);
    const operationLifetime = admission.lifetime;
    React.useEffect(() => {
        if (status !== 'exited' || !params.readOnly || !operationLifetime?.isCurrent()) return;
        void refreshTerminalActionOperation({
            serverId: operationLifetime.scope.serverId, accountId: operationLifetime.scope.accountId,
            machineId: params.machineId, terminalId: params.attachedTerminalId ?? null,
        }, operationLifetime);
    }, [status, operationState, operationLifetime, params.readOnly, params.machineId, params.attachedTerminalId]);
    // A reused terminal already started, even if this view's first read fails.
    // A fresh process is established only once its stream can actually be read.
    const hasEstablishedTerminalRef = React.useRef(false);
    const [terminalTitle, setTerminalTitle] = React.useState<string | null>(null);
    const [terminalBell, setTerminalBell] = React.useState<string | null>(null);
    const mountedRef = React.useRef(false);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    const [connectionAttempt, beginConnectionAttempt] = React.useReducer(
        (previous: Readonly<{ nonce: number; explicitRetry: boolean }>, explicitRetry: boolean) => ({
            nonce: previous.nonce + 1,
            explicitRetry,
        }),
        { nonce: 0, explicitRetry: false },
    );
    const connectionNonce = connectionAttempt.nonce;
    const bumpConnectionNonce = React.useCallback(() => beginConnectionAttempt(false), []);
    // A user Retry must reach the transport that can heal a failed observation.
    // Its in-flight request also survives that observation becoming reachable.
    const attemptMachineReachable = connectionAttempt.explicitRetry ? undefined : params.machineReachable;
    const attemptRpcTargetAvailable = connectionAttempt.explicitRetry ? undefined : params.machineRpcTargetAvailable;
    // Process intent is consumed once; the transport's reachability override
    // may remain active after that attempt has delivered its receipt.
    const requestedAdmissionRef = React.useRef<'open' | 'restart' | null>(null);
    const restartContextRef = React.useRef<ActionExecutorContext | undefined>(undefined);
    const autoRetryAttemptRef = React.useRef(0);
    const autoRetryTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearNonceRef = React.useRef(0);
    const heldReadRef = React.useRef<AbortController | null>(null);

    const terminalIdRef = React.useRef<string | null>(initialSurfaceState.terminalId);
    // A mounted controller retains its observed fact even when the bounded
    // preview cache evicts its bytes. That projection cannot grant open intent.
    const observedExitRef = React.useRef<Readonly<{ terminalKey: string; exit: NonNullable<TerminalSurfaceState['exit']> }> | null>(null);
    const cursorRef = React.useRef(initialSurfaceState.cursor);
    const cursorModeRef = React.useRef<TerminalStreamCursor['mode']>(initialSurfaceState.cursorMode);
    const terminalRendererHandleRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const terminalPreviewDecoderRef = React.useRef(createTerminalUtf8ProjectionDecoder());
    const terminalStreamCarrierRef = React.useRef<ReturnType<typeof createMachineRpcTerminalStreamCarrier> | null>(null);
    const terminalRendererAckDeliveryRef = React.useRef<TerminalRendererAckDelivery | null>(null);
    const terminalStreamRuntimeRef = React.useRef<TerminalStreamRuntime | null>(null);
    const terminalCreditStateRef = React.useRef<TerminalStreamCreditState | null>(null);
    const pendingRendererWriteRef = React.useRef<PendingRendererWrite | null>(null);
    const rendererWriteResumeRef = React.useRef<(() => void) | null>(null);
    const resumeRendererRead = React.useCallback(() => {
        const resume = rendererWriteResumeRef.current;
        rendererWriteResumeRef.current = null;
        resume?.();
    }, []);
    const handleWithdrawalRef = React.useRef<(code: string | null) => boolean>(() => false);
    const pendingWritePreviewBytesRef = React.useRef(new Map<string, Uint8Array>());
    const replaceCachedPreviewOnReplayRef = React.useRef(false);
    const terminalStreamDoneRef = React.useRef(false);
    const clearActiveTerminalStream = React.useCallback(() => {
        terminalRendererAckDeliveryRef.current?.dispose();
        terminalRendererAckDeliveryRef.current = null;
        terminalStreamCarrierRef.current = null;
        terminalStreamRuntimeRef.current = null;
        terminalCreditStateRef.current = null;
        pendingRendererWriteRef.current = null;
        resumeRendererRead();
        pendingWritePreviewBytesRef.current.clear();
        replaceCachedPreviewOnReplayRef.current = false;
        terminalStreamDoneRef.current = false;
    }, [resumeRendererRead]);
    const resetAutoRetryState = React.useCallback(() => {
        autoRetryAttemptRef.current = 0;
        safeTimeoutClear(autoRetryTimeoutRef.current);
        autoRetryTimeoutRef.current = null;
    }, []);

    const scheduleAutoRetry = React.useCallback(() => {
        const nextAttempt = autoRetryAttemptRef.current + 1;
        if (nextAttempt > TERMINAL_AUTO_RETRY_MAX_ATTEMPTS) {
            return false;
        }

        autoRetryAttemptRef.current = nextAttempt;
        safeTimeoutClear(autoRetryTimeoutRef.current);
        autoRetryTimeoutRef.current = safeTimeoutSet(() => {
            autoRetryTimeoutRef.current = null;
            bumpConnectionNonce();
        }, resolveTerminalAutoRetryDelayMs(nextAttempt));
        setError(null);
        setStatus('connecting');
        return true;
    }, [bumpConnectionNonce]);

    const onAttachedOutput = React.useCallback((state: TerminalSurfaceState) => {
        const lifetime = admissionRef.current.lifetime;
        if (state.terminalId && state.terminalId === params.attachedTerminalId && state.output
            && lifetime?.isCurrent() && areServerAccountScopesEqual(state.scope, lifetime.scope)) {
            params.onAttachedOutput?.(state.terminalId, state.output);
        }
    }, [params.attachedTerminalId, params.onAttachedOutput]);
    const {
        detectedUrl,
        outputRetention,
        syncOutputRetention,
        clearTerminalOutput,
        hydrateTerminalRendererIfNeeded,
        replaceSurfaceState,
        recordTerminalPreviewOutput,
        setDetectedUrl,
        syncDetectedUrl,
        updateSurfaceState,
        writeTerminalOutput,
    } = useTerminalSurfaceState({
        terminalKey: params.terminalKey,
        terminalRef: params.terminalRef,
        terminalIdRef,
        cursorRef,
        terminalRendererHandleRef,
        clearNonceRef,
        hydrateOnRender: false,
        onPreviewOutput: params.onAttachedOutput ? onAttachedOutput : undefined,
    });
    const recordTerminalExit = React.useCallback((exit?: Readonly<{ exitCode: number | null; signal: number | null }>) => {
        const state = updateSurfaceState(current => ({
            ...current,
            exit: { ...(exit ?? current.exit ?? { exitCode: null, signal: null }), scope: attachmentScopeRef.current },
        }));
        if (state.exit) observedExitRef.current = { terminalKey: params.terminalKey, exit: state.exit };
        setExitCode(state.exit?.exitCode ?? null);
        setExitSignal(state.exit?.signal ?? null);
        setStatus('exited');
    }, [params.terminalKey, updateSurfaceState]);
    const handleMissingTerminal = React.useCallback((code: string | null | undefined) => {
        if (code !== 'terminal_not_found' || params.readOnly || params.attachedTerminalId !== undefined || !terminalIdRef.current) return false;
        resetAutoRetryState();
        clearActiveTerminalStream();
        recordTerminalExit();
        setError(null);
        return true;
    }, [clearActiveTerminalStream, params.attachedTerminalId, params.readOnly, recordTerminalExit, resetAutoRetryState]);
    const handleInputError = React.useCallback((inputError: unknown) => {
        const inputErrorCode = readTerminalStreamInputErrorCode(inputError);
        if (handleWithdrawalRef.current(inputErrorCode) || handleMissingTerminal(inputErrorCode)) return;
        clearActiveTerminalStream();
        if (isRecoverableTerminalSessionErrorCode(inputErrorCode) && scheduleAutoRetry()) {
            return;
        }
        setStatus('error');
        setError(inputError instanceof Error && inputError.message
            ? inputError.message
            : inputErrorCode ?? 'terminal_input_failed');
    }, [clearActiveTerminalStream, handleMissingTerminal, scheduleAutoRetry]);
    const clearWithdrawnTerminal = React.useCallback((code: string) => {
        resetAutoRetryState();
        clearActiveTerminalStream();
        hasEstablishedTerminalRef.current = false;
        terminalIdRef.current = null;
        terminalPreviewDecoderRef.current.reset();
        params.terminalRef.current?.clear();
        replaceSurfaceState(createEmptyTerminalSurfaceState());
        setTerminalTitle(null);
        setTerminalBell(null);
        setStatus('error');
        setError(code);
    }, [clearActiveTerminalStream, params.terminalRef, replaceSurfaceState, resetAutoRetryState]);
    handleWithdrawalRef.current = code => {
        if (!code || !['terminal_forbidden', 'terminal_cwd_denied', 'terminal_access_denied', 'access_denied'].includes(code)) return false;
        clearWithdrawnTerminal(code);
        return true;
    };
    const acknowledgeAcceptedBytes = React.useCallback((input: Readonly<{
        terminalId: string;
        ackedByteOffset: number;
        writeGeneration?: number;
    }>) => {
        const state = terminalCreditStateRef.current;
        const delivery = terminalRendererAckDeliveryRef.current;
        if (!state || !delivery || input.terminalId !== terminalIdRef.current) {
            return;
        }
        if (input.writeGeneration !== undefined && state.surfaceEpoch !== input.writeGeneration) {
            return;
        }
        const ack = {
            terminalId: input.terminalId,
            rendererId: embeddedTerminalRendererId,
            surfaceEpoch: state.surfaceEpoch,
            ackedByteOffset: input.ackedByteOffset,
            creditBytes: state.creditBytes,
        };
        const result = applyTerminalRendererAck(state, ack);
        if (!result.accepted) {
            return;
        }
        terminalCreditStateRef.current = result.state;
        delivery.enqueue(ack);
    }, [embeddedTerminalRendererId]);
    const replaceCachedPreviewWithReplay = React.useCallback((terminalId: string) => {
        if (!replaceCachedPreviewOnReplayRef.current) {
            return;
        }
        replaceCachedPreviewOnReplayRef.current = false;
        terminalPreviewDecoderRef.current.reset();
        const renderer = params.terminalRef.current;
        if (renderer) {
            terminalRendererHandleRef.current = renderer;
            renderer.clear();
        }
        updateSurfaceState((current) => ({
            ...current,
            terminalId,
            cursor: cursorRef.current,
            cursorMode: cursorModeRef.current,
            output: '',
        }));
    }, [params.terminalRef, terminalRendererHandleRef, updateSurfaceState]);
    const {
        initialTerminalSize,
        latestTerminalSizeRef,
        onInput,
        onPaste,
        onResize,
        onReady: notifyTransportReady,
        flushPendingInput,
        inputRecoveryAvailable,
        readInputRecovery,
        discardInputRecovery: discardTransportInputRecovery,
        inputDraftAvailable,
        readInputDraft,
        resendInputDraft,
        discardInputDraft,
    } = useEmbeddedTerminalTransportHandlers({
        machineId: params.machineId,
        readOnly: params.readOnly,
        terminalIdRef,
        terminalStreamCarrierRef,
        onInputError: handleInputError,
    });
    const onReady = React.useCallback((cols: number, rows: number) => {
        notifyTransportReady(cols, rows);
        // Native crash/unavailability fallback is child-local state. Hydrate the
        // replacement renderer here because it does not rerender this hook owner.
        if (status === 'connected' || status === 'exited') {
            hydrateTerminalRendererIfNeeded();
        }
    }, [hydrateTerminalRendererIfNeeded, notifyTransportReady, status]);

    const clearTerminal = React.useCallback(() => {
        // Clear discards an in-flight read's bytes; a held read's next bytes are
        // output after this Clear, so release it instead of discarding them.
        heldReadRef.current?.abort();
        terminalPreviewDecoderRef.current.reset();
        pendingRendererWriteRef.current = null;
        resumeRendererRead();
        pendingWritePreviewBytesRef.current.clear();
        replaceCachedPreviewOnReplayRef.current = false;
        clearTerminalOutput();
    }, [clearTerminalOutput, resumeRendererRead]);

    const requestRestart = React.useCallback((context?: ActionExecutorContext) => {
        if (params.readOnly) return;
        hasEstablishedTerminalRef.current = false;
        resetAutoRetryState();
        requestedAdmissionRef.current = 'restart';
        restartContextRef.current = context;
        terminalPreviewDecoderRef.current.reset();
        clearActiveTerminalStream();
        cursorModeRef.current = byteStreamEnabled ? 'byte-offset' : 'legacy-event-cursor';
        clearTerminalOutput();
        syncDetectedUrl(null);
        bumpConnectionNonce();
    }, [bumpConnectionNonce, byteStreamEnabled, clearActiveTerminalStream, clearTerminalOutput, params.readOnly, resetAutoRetryState, syncDetectedUrl]);

    const retryConnect = React.useCallback(() => {
        resetAutoRetryState();
        requestedAdmissionRef.current = 'open';
        restartContextRef.current = undefined;
        beginConnectionAttempt(true);
    }, [resetAutoRetryState]);

    const discardInputRecovery = React.useCallback(() => {
        if (params.readOnly) return;
        discardTransportInputRecovery();
        // The recovery banner owns this explicit action even when an input failure retired
        // the carrier. Reuse the session's reconnect so the pending line clear can be delivered.
        if (terminalIdRef.current && !terminalStreamCarrierRef.current) retryConnect();
    }, [discardTransportInputRecovery, params.readOnly, retryConnect]);

    const onLink = React.useCallback((rawUrl: string) => {
        const action = resolveTerminalHyperlinkAction(rawUrl);
        if (action.kind === 'deny') {
            return;
        }
        syncDetectedUrl({
            t: 'url',
            url: action.url,
            kind: 'generic',
            suggestOpen: action.kind === 'allow',
        });
    }, [syncDetectedUrl]);

    const onTitle = React.useCallback((title: string) => {
        const sanitized = sanitizeTerminalTitle(title);
        void applyEmbeddedTerminalTitlePolicy(sanitized);
        setTerminalTitle(sanitized || null);
    }, []);

    const onBell = React.useCallback((label: string) => {
        const sanitized = sanitizeTerminalBell(label);
        void applyEmbeddedTerminalBellPolicy(sanitized);
        setTerminalBell(sanitized || null);
    }, []);

    const copySelection = React.useCallback((request?: Readonly<{
        source: 'user-selection' | 'remote-osc52' | 'input-recovery';
        text: string;
    }>) => {
        if (request?.source === 'remote-osc52') return;
        const text = request?.text ?? (params.terminalRef.current?.hasSelection?.()
            ? params.terminalRef.current.getSelectionText?.() ?? ''
            : '');
        if (text) void writeClipboard(text);
    }, [params.terminalRef, writeClipboard]);

    const copyInputRecovery = React.useCallback(async () => {
        const text = readInputRecovery();
        if (text) copySelection({ source: 'input-recovery', text });
    }, [copySelection, readInputRecovery]);
    const copyInputDraft = React.useCallback(async () => {
        const text = readInputDraft();
        if (text) copySelection({ source: 'input-recovery', text });
    }, [copySelection, readInputDraft]);

    React.useEffect(() => {
        return () => {
            safeTimeoutClear(autoRetryTimeoutRef.current);
            autoRetryTimeoutRef.current = null;
        };
    }, []);

    React.useEffect(() => {
        let canceled = false;
        let streaming = false;
        const interest = new AbortController();
        let attachmentLifetime = admissionRef.current.lifetime;
        const retire = () => {
            canceled = true;
            interest.abort();
            clearWithdrawnTerminal('terminal_forbidden');
        };
        let retirement = admissionRef.current.lifetime?.onRetire(retire);

        const start = async () => {
            let cachedSurfaceState = readTerminalSurfaceState(params.terminalKey) ?? createEmptyTerminalSurfaceState();
            const hydrateCachedPreview = async (scope: ServerAccountScope) => {
                if (cachedSurfaceState.terminalId && areServerAccountScopesEqual(cachedSurfaceState.scope, scope)
                    && (params.attachedTerminalId === undefined || params.attachedTerminalId === cachedSurfaceState.terminalId)) {
                    const resource = cachedSurfaceState.rendererResource;
                    if (resource) {
                        await resource.whenSettled();
                        if (canceled) return;
                        cachedSurfaceState = readTerminalSurfaceState(params.terminalKey) ?? createEmptyTerminalSurfaceState();
                        if (cachedSurfaceState.rendererResource !== resource
                            || !areServerAccountScopesEqual(cachedSurfaceState.scope, scope)) return;
                        if (params.terminalRef.current?.restoreResource?.(resource)) {
                            terminalRendererHandleRef.current = params.terminalRef.current;
                            terminalPreviewDecoderRef.current = cachedSurfaceState.previewDecoder ?? createTerminalUtf8ProjectionDecoder();
                        }
                    }
                    hydrateTerminalRendererIfNeeded();
                }
            };
            const mountedLifetime = admissionRef.current.lifetime;
            if (mountedLifetime?.isCurrent()) await hydrateCachedPreview(mountedLifetime.scope);
            const preserveOwnedExit = !params.readOnly && params.attachedTerminalId === undefined
                && !requestedAdmissionRef.current
                // Reopening a Session pane attaches to its current host. A
                // previous attachment's exit does not settle that host's life.
                && (params.launch?.kind !== 'session_attach'
                    || observedExitRef.current?.terminalKey === params.terminalKey);
            let knownExit = preserveOwnedExit && observedExitRef.current?.terminalKey === params.terminalKey
                ? observedExitRef.current.exit : cachedSurfaceState.exit;
            let retainedExit = (preserveOwnedExit || params.readOnly && params.attachedTerminalId === cachedSurfaceState.terminalId)
                && admissionRef.current.lifetime?.isCurrent()
                && areServerAccountScopesEqual(knownExit?.scope, admissionRef.current.lifetime.scope)
                ? knownExit : undefined;
            const retainOwnedExit = () => {
                if (!preserveOwnedExit || !retainedExit) return false;
                resetAutoRetryState();
                setExitCode(retainedExit.exitCode);
                setExitSignal(retainedExit.signal);
                setStatus('exited');
                hydrateTerminalRendererIfNeeded();
                return true;
            };

            setError(null);
            if (retainOwnedExit()) return;
            if (admissionRef.current.openCancelled && !requestedAdmissionRef.current) {
                setStatus('not-open');
                return;
            }
            // Retained attachments remain connecting while prerequisites settle.
            const waitingForConnection = params.attachedTerminalId !== undefined || Boolean(cachedSurfaceState.terminalId);
            setStatus(retainedExit ? 'exited' : waitingForConnection ? 'connecting' : 'not-open');

            if (!params.machineId || (!params.cwd && !params.launch && params.attachedTerminalId === undefined)) {
                setStatus('error');
                setError('terminal_missing_machine_target');
                return;
            }
            if (attemptMachineReachable === false) {
                setStatus('error');
                setError('terminal_machine_unreachable');
                return;
            }
            if (attemptRpcTargetAvailable === false) {
                setStatus('error');
                setError('terminal_rpc_target_unavailable');
                return;
            }
            if (attemptMachineReachable === null) {
                // Unknown presence waits in the admission state above; it is
                // not a terminal failure. Do not capture authority or attach yet.
                return;
            }
            if ((params.readOnly && !params.attachedTerminalId) || params.attachedTerminalId === null || (params.attachedTerminalId === undefined && !initialTerminalSize)) {
                setStatus(waitingForConnection ? 'connecting' : 'not-open');
                return;
            }

            const terminalSize = latestTerminalSizeRef.current ?? initialTerminalSize;
            // The renderer can accept keys while admission is pending. The
            // existing input owner holds them until this attempt attaches.
            setStatus(retainedExit ? 'exited' : 'connecting');
            const authority = await admission.capture(interest.signal);
            attachmentLifetime = authority;
            attachmentScopeRef.current = authority.scope;
            if (!retirement) retirement = authority.onRetire(retire);
            if (canceled) return;
            // A retained exit enables pre-replay hydration only for its original
            // Home/Account. Another Account must obtain its own authorized bytes.
            if (knownExit && !areServerAccountScopesEqual(knownExit.scope, authority.scope)
                || cachedSurfaceState.scope && !areServerAccountScopesEqual(cachedSurfaceState.scope, authority.scope)) {
                hasEstablishedTerminalRef.current = false;
                knownExit = undefined;
                cachedSurfaceState = createEmptyTerminalSurfaceState();
                replaceSurfaceState(cachedSurfaceState);
            }
            await hydrateCachedPreview(authority.scope);
            if (canceled) return;
            retainedExit = (preserveOwnedExit || params.readOnly && params.attachedTerminalId === cachedSurfaceState.terminalId)
                ? knownExit : undefined;
            // The canonical surface exit belongs to this Home/Account and key.
            // Effect/renderer/reachability changes are not new process intent.
            if (retainOwnedExit()) return;

            const request = {
                ...buildMachineTerminalSessionRequest({
                    terminalKey: params.terminalKey, cwd: params.cwd, cols: terminalSize?.cols, rows: terminalSize?.rows,
                    launch: params.launch,
                    workspace,
                }),
                ...(params.sessionId ? { sessionId: params.sessionId } : {}),
            };
            const ensured = params.attachedTerminalId
                ? { ok: true as const, terminalId: params.attachedTerminalId, reused: true }
                : await admission.admit(request, requestedAdmissionRef.current === 'restart', interest.signal, restartContextRef.current,
                    params.closeOnUnmount && !params.readOnly && params.attachedTerminalId === undefined
                        ? async (receipt, scope) => {
                            if (canceled && !mountedRef.current) {
                                await machineTerminalClose(params.machineId!, { terminalId: receipt.terminalId }, {
                                    serverId: scope.serverId, accountId: scope.accountId,
                                });
                            }
                        } : undefined, requestedAdmissionRef.current === 'open');
            requestedAdmissionRef.current = null;
            restartContextRef.current = undefined;
            if (!retirement) retirement = admissionRef.current.lifetime?.onRetire(retire);
            const scope = attachmentScopeRef.current;

            if (canceled) {
                if (ensured.ok && !mountedRef.current && params.closeOnUnmount && !params.readOnly && params.attachedTerminalId === undefined) {
                    await machineTerminalClose(params.machineId, { terminalId: ensured.terminalId }, {
                        serverId: scope?.serverId ?? params.serverId, accountId: scope?.accountId });
                }
                return;
            }
            if (!ensured.ok) {
                if (ensured.cancelled) {
                    resetAutoRetryState();
                    setStatus('not-open');
                    setError(null);
                    return;
                }
                const errorCode = resolveTerminalAdmissionErrorCode(ensured);
                if (handleWithdrawalRef.current(errorCode)) return;
                if ((isRecoverableTerminalRpcError(ensured) || isRecoverableTerminalSessionErrorCode(errorCode)) && scheduleAutoRetry()) {
                    return;
                }
                setStatus('error');
                setError(errorCode);
                return;
            }
            const replayMode: TerminalStreamCursor['mode'] = byteStreamEnabled
                ? 'byte-offset'
                : 'legacy-event-cursor';
            const replayPlan = resolveTerminalReplayPlan({
                cachedTerminalId: cachedSurfaceState.terminalId,
                ensuredTerminalId: ensured.terminalId,
                reused: ensured.reused,
                cachedOutput: cachedSurfaceState.output,
                replayMode,
                restoredCursor: params.terminalRef.current?.hasRetainedOutput?.()
                    && areServerAccountScopesEqual(cachedSurfaceState.scope, authority.scope)
                    ? { mode: cachedSurfaceState.cursorMode, value: cachedSurfaceState.cursor } : undefined,
            });
            hasEstablishedTerminalRef.current = ensured.reused
                || hasEstablishedTerminalRef.current && terminalIdRef.current === ensured.terminalId;
            terminalIdRef.current = ensured.terminalId;
            if (!retainedExit) observedExitRef.current = null;
            syncOutputRetention(ensured.terminalId, cachedSurfaceState.terminalId === ensured.terminalId
                ? cachedSurfaceState.outputRetention ?? null : null);
            cursorRef.current = replayPlan.initialCursor.value;
            cursorModeRef.current = replayPlan.initialCursor.mode;
            replaceCachedPreviewOnReplayRef.current = replayPlan.replacePreviewOnReplay;
            terminalStreamDoneRef.current = false;
            if (replayPlan.clearRenderer) {
                terminalPreviewDecoderRef.current.reset();
                terminalRendererHandleRef.current = params.terminalRef.current;
                params.terminalRef.current?.clear();
                replaceSurfaceState({
                    terminalId: ensured.terminalId,
                    scope: authority.scope,
                    cursor: replayPlan.initialCursor.value,
                    cursorMode: replayPlan.initialCursor.mode,
                    output: '',
                    detectedUrl: null,
                });
                setDetectedUrl(null);
            } else {
                const state = replaceSurfaceState({
                    ...cachedSurfaceState,
                    scope: authority.scope,
                    terminalId: ensured.terminalId,
                    cursor: replayPlan.initialCursor.value,
                    cursorMode: replayPlan.initialCursor.mode,
                    exit: retainedExit,
                });
                if (params.onAttachedOutput && !retainedExit) onAttachedOutput(state);
                hydrateTerminalRendererIfNeeded();
            }
            const rendererResource = params.terminalRef.current?.captureResource?.();
            if (rendererResource) updateSurfaceState(current => ({ ...current, rendererResource,
                previewDecoder: terminalPreviewDecoderRef.current }));
            // A borrowed process's observed termination remains true while its
            // retained output is reattached; transport readiness is not a new run.
            setStatus(retainedExit ? 'exited' : 'connected');
            setExitCode(retainedExit?.exitCode ?? null);
            setExitSignal(retainedExit?.signal ?? null);

            const carrier = createMachineRpcTerminalStreamCarrier({
                machineId: params.machineId,
                serverId: scope?.serverId ?? params.serverId,
                accountId: scope?.accountId,
                signal: interest.signal,
            });
            terminalStreamCarrierRef.current = carrier;
            flushPendingInput();
            terminalRendererAckDeliveryRef.current = createTerminalRendererAckDelivery({
                send: carrier.acknowledge,
                onDiagnostic: reportTerminalRendererAckDeliveryDiagnostic,
            });
            terminalCreditStateRef.current = byteStreamEnabled
                ? createTerminalStreamCreditState({
                    terminalId: ensured.terminalId,
                    rendererId: embeddedTerminalRendererId,
                    surfaceEpoch: connectionNonce,
                    ackedByteOffset: cursorRef.current,
                    creditBytes: TERMINAL_STREAM_MAX_READ_BYTES,
                })
                : null;
            const writeDecodedStreamProjection = (data: string) => {
                if (!data) {
                    return;
                }
                if (params.terminalRef.current?.writeBytes) {
                    recordTerminalPreviewOutput(data);
                    return;
                }
                writeTerminalOutput(data);
            };
            pendingRendererWriteRef.current = null;
            pendingWritePreviewBytesRef.current.clear();
            const runtime = createTerminalStreamRuntime({
                terminalId: ensured.terminalId,
                rendererId: embeddedTerminalRendererId,
                surfaceEpoch: connectionNonce,
                renderer: {
                    write: writeTerminalOutput,
                    writeBytes: (input) => {
                        const renderer = params.terminalRef.current;
                        if (renderer?.writeBytes) {
                            const result = renderer.writeBytes(input);
                            if (result === false) {
                                return false;
                            }
                            if (isQueuedRendererWriteResult(result)) {
                                pendingWritePreviewBytesRef.current.set(
                                    getRendererWriteKey(input),
                                    input.bytes,
                                );
                                return result;
                            }
                            const decodedPreview = terminalPreviewDecoderRef.current.decode(input.bytes);
                            recordTerminalPreviewOutput(decodedPreview);
                            return result;
                        }
                        const decodedPreview = terminalPreviewDecoderRef.current.decode(input.bytes);
                        return writeTerminalOutput(decodedPreview);
                    },
                    clear: () => params.terminalRef.current?.clear(),
                    focus: () => params.terminalRef.current?.focus?.(),
                    hasSelection: () => params.terminalRef.current?.hasSelection?.() ?? false,
                    getSelectionText: () => params.terminalRef.current?.getSelectionText?.() ?? '',
                },
                onGap: () => {
                    terminalPreviewDecoderRef.current.reset();
                    writeTerminalOutput(`\u0018${TERMINAL_OUTPUT_GAP_MARKER}`);
                },
                onUrl: (event) => {
                    syncDetectedUrl({
                        t: 'url',
                        url: event.url,
                        kind: event.kind,
                        suggestOpen: event.suggestOpen,
                    });
                },
                onExit: (event) => {
                    writeDecodedStreamProjection(terminalPreviewDecoderRef.current.flush());
                    terminalStreamDoneRef.current = true;
                    recordTerminalExit({ exitCode: event.exitCode, signal: event.signal });
                },
            });
            terminalStreamRuntimeRef.current = runtime;
            streaming = true;
            let idleCount = 0;
            while (!canceled) {
                if (terminalStreamDoneRef.current) {
                    return;
                }
                const terminalId = terminalIdRef.current;
                if (!terminalId) break;
                if (pendingRendererWriteRef.current) {
                    await new Promise<void>((resolve) => { rendererWriteResumeRef.current = resolve; });
                    continue;
                }
                const readClearNonce = clearNonceRef.current;

                const heldRead = new AbortController();
                heldReadRef.current = heldRead;
                const read = await carrier.read({
                    terminalId,
                    cursor: { mode: cursorModeRef.current, value: cursorRef.current },
                    ackedByteOffset: byteStreamEnabled ? terminalCreditStateRef.current?.ackedByteOffset : undefined,
                    creditBytes: byteStreamEnabled ? terminalCreditStateRef.current?.creditBytes : undefined,
                    rendererId: embeddedTerminalRendererId,
                    surfaceEpoch: connectionNonce,
                }, { signal: heldRead.signal }).catch((error: unknown) => {
                    if (heldRead.signal.aborted && !canceled) return null;
                    throw error;
                });
                if (canceled || terminalStreamRuntimeRef.current !== runtime) return;
                if (read === null) continue;

                if (!read.ok) {
                    if (handleWithdrawalRef.current(read.code) || handleMissingTerminal(read.code)) return;
                    clearActiveTerminalStream();
                    const recoverable = isRecoverableTerminalRpcError({ ok: false, errorCode: read.code }, 'stream');
                    if ((recoverable || isRecoverableTerminalSessionErrorCode(read.code)) && scheduleAutoRetry()) {
                        return;
                    }
                    setStatus('error');
                    setError(recoverable ? 'terminal_rpc_target_unavailable' : read.code);
                    return;
                }
                // A successful ensure does not prove that its stream can be
                // read. Reset recovery only after transport actually recovers.
                hasEstablishedTerminalRef.current = true;
                if (autoRetryAttemptRef.current > 0) resetAutoRetryState();
                syncOutputRetention(terminalId, read.outputRetention ?? null);

                if (read.mode === 'legacy-event-cursor') {
                    terminalCreditStateRef.current = null;
                }

                if (readClearNonce !== clearNonceRef.current) {
                    const priorCursor = cursorRef.current;
                    const priorCursorMode = cursorModeRef.current;
                    cursorRef.current = read.nextCursor;
                    cursorModeRef.current = read.mode;
                    if (read.nextCursor !== priorCursor || read.mode !== priorCursorMode) {
                        updateSurfaceState((current) => ({
                            ...current,
                            terminalId,
                            cursor: read.nextCursor,
                            cursorMode: read.mode,
                        }));
                    }
                    if (read.frames.some((event) => event.t === 'exit') || read.done) {
                        terminalStreamDoneRef.current = true;
                        recordTerminalExit();
                        return;
                    }
                    idleCount = 0;
                    continue;
                }

                // Current producers own the wait. Snapshot-only predecessors
                // retain their existing pacing after capability negotiation.
                if (read.frames.length === 0 && read.holdForOutput !== true) {
                    idleCount = Math.min(10, idleCount + 1);
                    await delay(Math.min(250, 60 + idleCount * 10));
                } else {
                    idleCount = 0;
                }

                if (containsTerminalReplayOutput(read.frames, terminalId)) {
                    replaceCachedPreviewWithReplay(terminalId);
                }
                const applied = runtime.applyFrames(read.frames);
                const priorCursor = cursorRef.current;
                if (applied.queuedWrite) {
                    if (read.mode === 'byte-offset' && applied.acceptedByteOffset !== null) {
                        const acceptedCursor = Math.min(read.nextCursor, applied.acceptedByteOffset);
                        const priorAcceptedCursor = cursorRef.current;
                        const priorAcceptedCursorMode = cursorModeRef.current;
                        cursorRef.current = acceptedCursor;
                        cursorModeRef.current = read.mode;
                        if (acceptedCursor !== priorAcceptedCursor || read.mode !== priorAcceptedCursorMode) {
                            updateSurfaceState((current) => ({
                                ...current,
                                terminalId,
                                cursor: acceptedCursor,
                                cursorMode: read.mode,
                            }));
                        }
                        acknowledgeAcceptedBytes({ terminalId, ackedByteOffset: applied.acceptedByteOffset });
                    }
                    const previewKey = getRendererWriteKey(applied.queuedWrite);
                    pendingRendererWriteRef.current = {
                        ...applied.queuedWrite,
                        previewBytes: pendingWritePreviewBytesRef.current.get(previewKey) ?? new Uint8Array(),
                        nextCursor: read.mode === 'legacy-event-cursor'
                            ? { mode: 'legacy-event-cursor', value: applied.queuedWrite.seq + 1 }
                            : {
                                mode: 'byte-offset',
                                value: Math.min(read.nextCursor, applied.queuedWrite.ackedByteOffset),
                            },
                        deferredFrames: applied.deferredFrames ?? [],
                        responseCursor: { mode: read.mode, value: read.nextCursor },
                        responseDone: read.done,
                    };
                    pendingWritePreviewBytesRef.current.delete(previewKey);
                    continue;
                }
                const nextCursor = read.mode === 'byte-offset' && applied.rejectedByteOffset !== null
                    ? applied.acceptedByteOffset ?? priorCursor
                    : read.mode === 'byte-offset' && applied.acceptedByteOffset !== null
                        ? Math.min(read.nextCursor, applied.acceptedByteOffset)
                        : read.nextCursor;
                const priorCursorMode = cursorModeRef.current;
                cursorRef.current = nextCursor;
                cursorModeRef.current = read.mode;
                if (nextCursor !== priorCursor || read.mode !== priorCursorMode) {
                    updateSurfaceState((current) => ({
                        ...current,
                        terminalId,
                        cursor: nextCursor,
                        cursorMode: read.mode,
                    }));
                }

                if (read.mode === 'byte-offset' && applied.acceptedByteOffset !== null) {
                    acknowledgeAcceptedBytes({ terminalId, ackedByteOffset: applied.acceptedByteOffset });
                }

                if (applied.rejectedByteOffset !== null) {
                    idleCount = Math.min(10, idleCount + 1);
                    await delay(Math.min(250, 60 + idleCount * 10));
                    continue;
                }

                if (applied.status === 'exited') {
                    terminalStreamDoneRef.current = true;
                    recordTerminalExit();
                    return;
                }

                if (read.done) {
                    terminalStreamDoneRef.current = true;
                    recordTerminalExit();
                    return;
                }
            }
        };

        void start().catch((e) => {
            if (canceled) return;
            const errorCode = readTerminalStreamInputErrorCode(e);
            if (handleWithdrawalRef.current(errorCode) || handleMissingTerminal(errorCode)) return;
            clearActiveTerminalStream();
            const recoverable = isRecoverableTerminalRpcError(e, streaming ? 'stream' : 'admission');
            if (recoverable && scheduleAutoRetry()) {
                return;
            }
            setStatus('error');
            setError(recoverable
                ? 'terminal_rpc_target_unavailable'
                : e instanceof Error ? e.message : 'terminal_error');
        });

        return () => {
            canceled = true;
            // Parser settlement may retain the old reader, never its input route.
            terminalStreamCarrierRef.current = null;
            interest.abort();
            retirement?.dispose();
            const resource = readTerminalSurfaceState(params.terminalKey)?.rendererResource;
            const runtime = terminalStreamRuntimeRef.current;
            if (resource && attachmentLifetime?.isCurrent()) {
                // A parser write already accepted by the old renderer completes
                // before adoption. Undelivered response frames belong to the next reader.
                const pending = pendingRendererWriteRef.current;
                if (pending) pendingRendererWriteRef.current = { ...pending,
                    deferredFrames: [], responseCursor: pending.nextCursor, responseDone: false };
                terminalRendererAckDeliveryRef.current?.dispose();
                terminalRendererAckDeliveryRef.current = null;
                void resource.whenSettled().then(() => {
                    if (terminalStreamRuntimeRef.current === runtime) clearActiveTerminalStream();
                });
            } else clearActiveTerminalStream();
        };
    }, [
        acknowledgeAcceptedBytes,
        admission.admit,
        admission.capture,
        clearWithdrawnTerminal,
        handleMissingTerminal,
        connectionNonce,
        attemptMachineReachable,
        attemptRpcTargetAvailable,
        byteStreamEnabled,
        embeddedTerminalRendererId,
        clearActiveTerminalStream,
        flushPendingInput,
        hydrateTerminalRendererIfNeeded,
        initialTerminalSize,
        latestTerminalSizeRef,
        params.cwd,
        params.launch,
        params.attachedTerminalId,
        params.onAttachedOutput,
        onAttachedOutput,
        params.readOnly,
        params.sessionId,
        workspace,
        params.closeOnUnmount,
        params.machineId,
        params.serverId,
        params.terminalKey,
        params.terminalRef,
        replaceSurfaceState,
        recordTerminalPreviewOutput,
        recordTerminalExit,
        replaceCachedPreviewWithReplay,
        resetAutoRetryState,
        scheduleAutoRetry,
        syncOutputRetention,
        setDetectedUrl,
        syncDetectedUrl,
        updateSurfaceState,
        writeTerminalOutput,
    ]);

    // A lost established attachment waits for the existing Home/Machine transport
    // reconnect (network recovery, foreground) and re-attaches then; it adds no timer.
    // A person's Reconnect starts its own attempt and supersedes this wait.
    const awaitingTransportRecovery = status === 'error' && hasEstablishedTerminalRef.current;
    React.useEffect(() => {
        if (!awaitingTransportRecovery || !params.machineId) return undefined;
        const scope = attachmentScopeRef.current;
        return subscribeMachineRpcRecovery({ machineId: params.machineId, serverId: scope?.serverId ?? params.serverId,
            expectedAccountId: scope?.accountId }, () => {
            resetAutoRetryState();
            bumpConnectionNonce();
        });
    }, [awaitingTransportRecovery, bumpConnectionNonce, params.machineId, params.serverId, resetAutoRetryState]);

    React.useEffect(() => {
        return () => {
            if (!params.closeOnUnmount || params.readOnly || params.attachedTerminalId !== undefined || !params.machineId || !terminalIdRef.current) return;
            const scope = attachmentScopeRef.current;
            void machineTerminalClose(params.machineId, { terminalId: terminalIdRef.current }, {
                serverId: scope?.serverId ?? params.serverId, accountId: scope?.accountId }).catch(() => {
                // The pane is disposed. A lost close receipt cannot recover its
                // transport or authorize another close from this retired view.
            });
        };
    }, [params.attachedTerminalId, params.closeOnUnmount, params.machineId, params.readOnly, params.serverId]);

    React.useEffect(() => {
        if (status !== 'connected' && status !== 'exited') {
            return;
        }
        hydrateTerminalRendererIfNeeded();
    });

    const closeForDismissal = React.useCallback(async (): Promise<boolean> => {
        if (!params.closeOnUnmount || params.readOnly || params.attachedTerminalId !== undefined) return true;
        const terminalId = terminalIdRef.current;
        if (!terminalId) return true;
        const scope = attachmentScopeRef.current;
        if (!scope || !await admissionRef.current.close(terminalId, scope)) return false;
        if (terminalIdRef.current !== terminalId) return false;
        terminalIdRef.current = null;
        return true;
    }, [params.attachedTerminalId, params.closeOnUnmount, params.readOnly]);

    const dismissDetectedUrl = React.useCallback(() => {
        syncDetectedUrl(null);
    }, [syncDetectedUrl]);

    const onWriteComplete = React.useCallback((event: EmbeddedTerminalWriteCompleteEvent) => {
        const pendingWrite = pendingRendererWriteRef.current;
        const runtime = terminalStreamRuntimeRef.current;
        if (!pendingWrite || !runtime || !isMatchingRendererWriteIdentity(event, pendingWrite)) {
            return;
        }
        const expectedAckedByteOffset = pendingWrite.byteOffset + pendingWrite.byteLength;
        if (event.ackedByteOffset > expectedAckedByteOffset) {
            return;
        }
        pendingRendererWriteRef.current = null;
        resumeRendererRead();
        pendingWritePreviewBytesRef.current.delete(getRendererWriteKey(pendingWrite));
        if (event.ackedByteOffset < expectedAckedByteOffset) {
            const retryCursor = pendingWrite.nextCursor.mode === 'byte-offset'
                ? pendingWrite.byteOffset
                : cursorRef.current;
            const priorCursor = cursorRef.current;
            const priorCursorMode = cursorModeRef.current;
            cursorRef.current = retryCursor;
            cursorModeRef.current = pendingWrite.nextCursor.mode;
            if (retryCursor !== priorCursor || pendingWrite.nextCursor.mode !== priorCursorMode) {
                updateSurfaceState((current) => ({
                    ...current,
                    terminalId: event.terminalId,
                    cursor: retryCursor,
                    cursorMode: pendingWrite.nextCursor.mode,
                }));
            }
            return;
        }
        if (pendingWrite.previewBytes.byteLength > 0) {
            recordTerminalPreviewOutput(terminalPreviewDecoderRef.current.decode(pendingWrite.previewBytes));
        }
        const nextCursor = pendingWrite.nextCursor.value;
        const priorPendingCursor = cursorRef.current;
        const priorPendingCursorMode = cursorModeRef.current;
        cursorRef.current = nextCursor;
        cursorModeRef.current = pendingWrite.nextCursor.mode;
        if (nextCursor !== priorPendingCursor || pendingWrite.nextCursor.mode !== priorPendingCursorMode) {
            updateSurfaceState((current) => ({
                ...current,
                terminalId: event.terminalId,
                cursor: nextCursor,
                cursorMode: pendingWrite.nextCursor.mode,
            }));
        }
        acknowledgeAcceptedBytes({
            terminalId: event.terminalId,
            ackedByteOffset: event.ackedByteOffset,
            writeGeneration: event.writeGeneration,
        });

        if (containsTerminalReplayOutput(pendingWrite.deferredFrames, event.terminalId)) {
            replaceCachedPreviewWithReplay(event.terminalId);
        }
        const applied = runtime.applyFrames(pendingWrite.deferredFrames);
        if (applied.queuedWrite) {
            if (pendingWrite.responseCursor.mode === 'byte-offset' && applied.acceptedByteOffset !== null) {
                const acceptedCursor = Math.min(pendingWrite.responseCursor.value, applied.acceptedByteOffset);
                const priorAcceptedCursor = cursorRef.current;
                const priorAcceptedCursorMode = cursorModeRef.current;
                cursorRef.current = acceptedCursor;
                cursorModeRef.current = pendingWrite.responseCursor.mode;
                if (acceptedCursor !== priorAcceptedCursor || pendingWrite.responseCursor.mode !== priorAcceptedCursorMode) {
                    updateSurfaceState((current) => ({
                        ...current,
                        terminalId: event.terminalId,
                        cursor: acceptedCursor,
                        cursorMode: pendingWrite.responseCursor.mode,
                    }));
                }
                acknowledgeAcceptedBytes({ terminalId: event.terminalId, ackedByteOffset: applied.acceptedByteOffset });
            }
            const previewKey = getRendererWriteKey(applied.queuedWrite);
            pendingRendererWriteRef.current = {
                ...applied.queuedWrite,
                previewBytes: pendingWritePreviewBytesRef.current.get(previewKey) ?? new Uint8Array(),
                nextCursor: pendingWrite.responseCursor.mode === 'legacy-event-cursor'
                    ? { mode: 'legacy-event-cursor', value: applied.queuedWrite.seq + 1 }
                    : {
                        mode: 'byte-offset',
                        value: Math.min(pendingWrite.responseCursor.value, applied.queuedWrite.ackedByteOffset),
                    },
                deferredFrames: applied.deferredFrames ?? [],
                responseCursor: pendingWrite.responseCursor,
                responseDone: pendingWrite.responseDone,
            };
            pendingWritePreviewBytesRef.current.delete(previewKey);
            return;
        }

        const priorCursor = cursorRef.current;
        const priorCursorMode = cursorModeRef.current;
        const finalCursor = pendingWrite.responseCursor.mode === 'byte-offset'
            && applied.rejectedByteOffset !== null
            ? applied.acceptedByteOffset ?? priorCursor
            : pendingWrite.responseCursor.value;
        cursorRef.current = finalCursor;
        cursorModeRef.current = pendingWrite.responseCursor.mode;
        if (finalCursor !== priorCursor || pendingWrite.responseCursor.mode !== priorCursorMode) {
            updateSurfaceState((current) => ({
                ...current,
                terminalId: event.terminalId,
                cursor: finalCursor,
                cursorMode: pendingWrite.responseCursor.mode,
            }));
        }
        if (pendingWrite.responseCursor.mode === 'byte-offset' && applied.acceptedByteOffset !== null) {
            acknowledgeAcceptedBytes({ terminalId: event.terminalId, ackedByteOffset: applied.acceptedByteOffset });
        }
        if (applied.rejectedByteOffset !== null) {
            return;
        }
        if (applied.status === 'exited' || pendingWrite.responseDone) {
            terminalStreamDoneRef.current = true;
            recordTerminalExit();
        }
    }, [
        acknowledgeAcceptedBytes,
        resumeRendererRead,
        recordTerminalPreviewOutput,
        recordTerminalExit,
        replaceCachedPreviewWithReplay,
        updateSurfaceState,
    ]);

    return {
        status,
        rendererResource: admission.lifetime?.isCurrent()
            && areServerAccountScopesEqual(initialSurfaceState.scope, admission.lifetime.scope)
            && (params.attachedTerminalId === undefined || params.attachedTerminalId === initialSurfaceState.terminalId)
            ? initialSurfaceState.rendererResource : undefined,
        readOnly: params.readOnly === true,
        operationState,
        terminalId: terminalIdRef.current,
        closeForDismissal,
        error,
        exitCode,
        exitSignal,
        outputRetention: admission.lifetime?.isCurrent()
            && areServerAccountScopesEqual(attachmentScopeRef.current, admission.lifetime.scope)
            && (!params.readOnly || params.attachedTerminalId === terminalIdRef.current)
            && outputRetention?.terminalId === terminalIdRef.current ? outputRetention : null,
        connectionLost: status === 'error' && hasEstablishedTerminalRef.current,
        connectionRetryAvailable: hasEstablishedTerminalRef.current || autoRetryAttemptRef.current > 0 || connectionAttempt.explicitRetry,
        inputRecoveryAvailable,
        copyInputRecovery,
        discardInputRecovery,
        inputDraftAvailable: inputDraftAvailable && !params.readOnly,
        copyInputDraft,
        resendInputDraft,
        discardInputDraft,
        detectedUrl,
        onInput,
        onPaste,
        onLink,
        onTitle,
        onBell,
        terminalTitle,
        terminalBell,
        approvalId: admission.approvalId,
        approvalPending: admission.approvalPending,
        approvalServerId: admission.approvalServerId,
        copySelection,
        onResize,
        onReady,
        clearTerminal,
        requestRestart,
        retryConnect,
        dismissDetectedUrl,
        onWriteComplete,
    } as const;
}

function isQueuedRendererWriteResult(
    result: ReturnType<NonNullable<EmbeddedTerminalRendererHandle['writeBytes']>>,
): result is Readonly<{ status: 'queued' }> {
    return typeof result === 'object' && result !== null && result.status === 'queued';
}

function reportTerminalRendererAckDeliveryDiagnostic(
    diagnostic: TerminalRendererAckDeliveryDiagnostic,
): void {
    if (diagnostic.kind === 'delivery-suppressed') {
        return;
    }
    if (diagnostic.kind === 'retry-scheduled') {
        console.warn('[terminal-stream] renderer ACK delivery failed; retry scheduled', {
            errorCode: diagnostic.errorCode,
            retryAttempt: diagnostic.retryAttempt,
        });
        return;
    }
    console.warn('[terminal-stream] renderer ACK delivery failed; retry budget exhausted', {
        errorCode: diagnostic.errorCode,
        retryAttempts: diagnostic.retryAttempts,
    });
}

function containsTerminalReplayOutput(frames: readonly TerminalStreamFrame[], terminalId: string): boolean {
    return frames.some((frame) => frame.terminalId === terminalId && (frame.t === 'bytes' || frame.t === 'gap'));
}

function getRendererWriteKey(input: Pick<EmbeddedTerminalWriteCompleteEvent, 'terminalId' | 'seq' | 'byteOffset' | 'writeGeneration'>): string {
    return `${input.terminalId}:${input.seq}:${input.byteOffset}:${input.writeGeneration}`;
}

function isMatchingRendererWriteIdentity(
    event: EmbeddedTerminalWriteCompleteEvent,
    pending: EmbeddedTerminalWriteCompleteEvent,
): boolean {
    return event.terminalId === pending.terminalId
        && event.seq === pending.seq
        && event.byteOffset === pending.byteOffset
        && event.byteLength === pending.byteLength
        && event.writeGeneration === pending.writeGeneration;
}

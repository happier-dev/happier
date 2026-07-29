import {
    BrowserAutomationErrorCodeV1Schema,
    BrowserInjectedRuntimeCommandMessageV1Schema,
    BrowserInjectedRuntimeResultMessageV1Schema,
    type BrowserAutomationErrorCodeV1,
    type BrowserInjectedRuntimeCommandMessageV1,
    type BrowserInjectedRuntimeResultMessageV1,
} from '@happier-dev/protocol';

import type {
    BrowserAutomationAuthority,
    BrowserAutomationOwner,
    BrowserAutomationRequest,
    BrowserAutomationResult,
    BrowserAutomationResultStatus,
} from '@/sync/domains/browser/automation';

type InjectedRuntimeIdentity = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    collectorId: string;
    nonce: string;
    capabilityVersion: string;
    runtimeId?: string;
}>;

export type BuildInjectedBrowserAutomationCommandInput = InjectedRuntimeIdentity & Readonly<{
    commandId: string;
    commandName: string;
    frameId?: string;
    payload?: Readonly<Record<string, unknown>>;
}>;

export type ParseInjectedBrowserAutomationResult =
    | Readonly<{
        ok: true;
        result: BrowserInjectedRuntimeResultMessageV1;
      }>
    | Readonly<{
        ok: false;
        reasonCode:
            | 'collector_mismatch'
            | 'invalid_json'
            | 'navigation_mismatch'
            | 'navigation_stale'
            | 'schema_invalid'
            | 'wrong_kind';
      }>;

export type InjectedPageAutomationTransport = Readonly<{
    sendCommand: (
        command: BrowserInjectedRuntimeCommandMessageV1,
        script: string,
    ) => void | Promise<void>;
    subscribeToResults: (listener: (raw: string) => void) => () => void;
}>;

export type CreateInjectedPageAutomationOwnerInput = InjectedRuntimeIdentity & Readonly<{
    ownerId: string;
    authority?: BrowserAutomationAuthority;
    adapterKind: string;
    supportedActions: readonly string[];
    transport: InjectedPageAutomationTransport;
    nowMs: () => number;
}>;

export type CreateWebIframeAutomationOwnerInput = Omit<
    CreateInjectedPageAutomationOwnerInput,
    'transport'
> & Readonly<{
    targetWindow: Readonly<{
        postMessage: (message: string, targetOrigin: string) => void;
    }> | null;
    targetOrigin: string | null;
    subscribeToMessages: (listener: (raw: string) => void) => () => void;
}>;

export type CreateNativeWebViewAutomationOwnerInput = Omit<
    CreateInjectedPageAutomationOwnerInput,
    'transport'
> & Readonly<{
    injectJavaScript: (script: string) => void;
    subscribeToMessages: (listener: (raw: string) => void) => () => void;
}>;

function runtimeIdFor(input: Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    runtimeId?: string;
}>): string {
    return input.runtimeId ?? `${input.browserSessionId}:${input.viewId}:${input.navigationGeneration}`;
}

function safeJsonForScript(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

function resultStatusForError(errorCode: string | undefined, stale: boolean): BrowserAutomationResultStatus {
    if (stale || errorCode === 'stale_navigation' || errorCode === 'navigation_mismatch') {
        return 'stale';
    }
    if (errorCode === 'timed_out' || errorCode === 'page_thread_blocked') {
        return 'timed_out';
    }
    if (errorCode === 'blocked_by_policy' || errorCode === 'policy_denied') {
        return 'policy_denied';
    }
    if (errorCode === 'unsupported_action') {
        return 'unsupported';
    }
    if (errorCode === 'cross_origin_frame_unavailable') {
        return 'unsupported';
    }
    return 'failed';
}

function readAbortReason(signal: AbortSignal): BrowserAutomationErrorCodeV1 {
    const reason = signal.reason;
    if (typeof reason === 'string' && reason.trim().length > 0) {
        const parsed = BrowserAutomationErrorCodeV1Schema.safeParse(reason);
        if (parsed.success) return parsed.data;
    }
    return 'owner_disconnected';
}

export function buildInjectedBrowserAutomationCommandMessage(
    input: BuildInjectedBrowserAutomationCommandInput,
): BrowserInjectedRuntimeCommandMessageV1 {
    return BrowserInjectedRuntimeCommandMessageV1Schema.parse({
        v: 1,
        kind: 'browser.injectedRuntime.command',
        runtimeId: runtimeIdFor(input),
        collectorId: input.collectorId,
        nonce: input.nonce,
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        navigationGeneration: input.navigationGeneration,
        ...(input.frameId ? { frameId: input.frameId } : {}),
        commandId: input.commandId,
        capabilityVersion: input.capabilityVersion,
        module: 'automation',
        commandName: input.commandName,
        payload: input.payload ?? {},
    });
}

export function buildInjectedBrowserAutomationCommandScript(
    input: BuildInjectedBrowserAutomationCommandInput,
): string {
    const command = safeJsonForScript(buildInjectedBrowserAutomationCommandMessage(input));

    return `
(function () {
  var runtime = window.__happierBrowserRuntime;
  var module = runtime && runtime.modules && runtime.modules.automation;
  if (module && typeof module.execute === 'function') {
    module.execute(${command});
  }
})(); true;
`;
}

export function parseInjectedBrowserAutomationResultMessage(
    raw: string,
    expected: InjectedRuntimeIdentity & Readonly<{ runtimeId: string }>,
): ParseInjectedBrowserAutomationResult {
    let parsedRaw: unknown;
    try {
        parsedRaw = JSON.parse(raw);
    } catch {
        return { ok: false, reasonCode: 'invalid_json' };
    }

    if (typeof parsedRaw !== 'object' || parsedRaw === null || Array.isArray(parsedRaw)) {
        return { ok: false, reasonCode: 'schema_invalid' };
    }

    const record = parsedRaw as Readonly<Record<string, unknown>>;
    if (record.kind !== 'browser.injectedRuntime.result') {
        return { ok: false, reasonCode: 'wrong_kind' };
    }
    if (
        record.browserSessionId !== expected.browserSessionId
        || record.viewId !== expected.viewId
        || record.collectorId !== expected.collectorId
        || record.nonce !== expected.nonce
    ) {
        return { ok: false, reasonCode: 'collector_mismatch' };
    }
    if (typeof record.navigationGeneration !== 'number') {
        return { ok: false, reasonCode: 'schema_invalid' };
    }
    if (record.navigationGeneration < expected.navigationGeneration) {
        return { ok: false, reasonCode: 'navigation_stale' };
    }
    if (record.navigationGeneration !== expected.navigationGeneration) {
        return { ok: false, reasonCode: 'navigation_mismatch' };
    }
    if (record.runtimeId !== expected.runtimeId) {
        return { ok: false, reasonCode: 'collector_mismatch' };
    }

    const parsed = BrowserInjectedRuntimeResultMessageV1Schema.safeParse(parsedRaw);
    if (!parsed.success) {
        return { ok: false, reasonCode: 'schema_invalid' };
    }
    return {
        ok: true,
        result: parsed.data,
    };
}

export function createInjectedPageAutomationOwner(
    input: CreateInjectedPageAutomationOwnerInput,
): BrowserAutomationOwner {
    const runtimeId = runtimeIdFor(input);
    const expected = {
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        navigationGeneration: input.navigationGeneration,
        collectorId: input.collectorId,
        nonce: input.nonce,
        capabilityVersion: input.capabilityVersion,
        runtimeId,
    } as const;

    return {
        ownerId: input.ownerId,
        authority: input.authority ?? 'uiLocal',
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        navigationGeneration: input.navigationGeneration,
        adapterKind: input.adapterKind,
        fidelity: 'injectedPage',
        trustedInput: false,
        supportedActions: input.supportedActions,
        executeAction(request: BrowserAutomationRequest, context: Readonly<{ signal: AbortSignal }>) {
            const startedAtMs = input.nowMs();
            const command = buildInjectedBrowserAutomationCommandMessage({
                ...expected,
                commandId: request.automationRequestId,
                commandName: request.actionKind,
                payload: request.payload ?? {},
            });
            const script = buildInjectedBrowserAutomationCommandScript({
                ...expected,
                commandId: request.automationRequestId,
                commandName: request.actionKind,
                payload: request.payload ?? {},
            });

            return new Promise<BrowserAutomationResult>((resolve) => {
                let settled = false;
                let unsubscribe: (() => void) | null = null;
                let timeoutId: ReturnType<typeof setTimeout> | null = null;

                const settle = (result: BrowserAutomationResult): void => {
                    if (settled) return;
                    settled = true;
                    context.signal.removeEventListener('abort', handleAbort);
                    if (timeoutId) {
                        clearTimeout(timeoutId);
                        timeoutId = null;
                    }
                    unsubscribe?.();
                    unsubscribe = null;
                    resolve({
                        ...result,
                        automationRequestId: request.automationRequestId,
                        durationMs: result.durationMs ?? Math.max(0, input.nowMs() - startedAtMs),
                    });
                };

                const handleAbort = (): void => {
                    settle({
                        status: 'canceled',
                        errorCode: readAbortReason(context.signal),
                    });
                };

                if (context.signal.aborted) {
                    handleAbort();
                    return;
                }

                context.signal.addEventListener('abort', handleAbort, { once: true });
                unsubscribe = input.transport.subscribeToResults((raw) => {
                    const parsed = parseInjectedBrowserAutomationResultMessage(raw, expected);
                    if (!parsed.ok) return;
                    if (parsed.result.commandId !== request.automationRequestId) return;
                    settle(parsed.result.ok
                        ? {
                            status: 'succeeded',
                            durationMs: parsed.result.durationMs,
                        }
                        : {
                            status: resultStatusForError(parsed.result.errorCode, parsed.result.stale),
                            errorCode: parsed.result.errorCode ?? 'runtime_unavailable',
                            durationMs: parsed.result.durationMs,
                        });
                });

                timeoutId = setTimeout(() => {
                    settle({
                        status: 'timed_out',
                        errorCode: 'timed_out',
                    });
                }, Math.max(1, request.timeoutMs));

                Promise.resolve(input.transport.sendCommand(command, script)).catch((error: unknown) => {
                    const errorCode = error instanceof Error && error.message === 'cross_origin_frame_unavailable'
                        ? 'cross_origin_frame_unavailable'
                        : 'runtime_unavailable';
                    settle({
                        status: resultStatusForError(errorCode, false),
                        errorCode,
                    });
                });
            });
        },
    };
}

export function createWebIframeAutomationOwner(
    input: CreateWebIframeAutomationOwnerInput,
): BrowserAutomationOwner {
    return createInjectedPageAutomationOwner({
        ...input,
        transport: {
            sendCommand(command) {
                if (!input.targetWindow || !input.targetOrigin) {
                    throw new Error('cross_origin_frame_unavailable');
                }
                input.targetWindow.postMessage(JSON.stringify(command), input.targetOrigin);
            },
            subscribeToResults: input.subscribeToMessages,
        },
    });
}

export function createNativeWebViewAutomationOwner(
    input: CreateNativeWebViewAutomationOwnerInput,
): BrowserAutomationOwner {
    return createInjectedPageAutomationOwner({
        ...input,
        transport: {
            sendCommand(_command, script) {
                input.injectJavaScript(script);
            },
            subscribeToResults: input.subscribeToMessages,
        },
    });
}

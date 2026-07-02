import type { AgentMessage } from '@/agent/core/AgentMessage';

import type { AcpRuntimeBackend } from '@/agent/acp/runtime/createAcpRuntime';

export type FakeAcpRuntimeBackend = AcpRuntimeBackend & {
    emit: (msg: AgentMessage) => void;
};

type FakeAcpRuntimeBackendOptions = {
    sessionId?: string;
    startSession?: AcpRuntimeBackend['startSession'];
    sendPrompt?: AcpRuntimeBackend['sendPrompt'];
    compactContext?: AcpRuntimeBackend['compactContext'];
    waitForResponseComplete?: AcpRuntimeBackend['waitForResponseComplete'];
    setSessionMode?: AcpRuntimeBackend['setSessionMode'];
    setSessionModel?: AcpRuntimeBackend['setSessionModel'];
    setSessionConfigOption?: AcpRuntimeBackend['setSessionConfigOption'];
    cancel?: AcpRuntimeBackend['cancel'];
    dispose?: AcpRuntimeBackend['dispose'];
};

export function createFakeAcpRuntimeBackend(opts?: FakeAcpRuntimeBackendOptions): FakeAcpRuntimeBackend {
    let handler: ((msg: AgentMessage) => void) | null = null;
    const sessionId = opts?.sessionId ?? 'sess_main';

    return {
        onMessage(fn: (msg: AgentMessage) => void) {
            handler = fn;
        },
        async startSession(initialPrompt?: string) {
            if (opts?.startSession) {
                return await opts.startSession(initialPrompt);
            }
            return { sessionId };
        },
        async sendPrompt(activeSessionId: string, prompt: string) {
            if (opts?.sendPrompt) {
                return await opts.sendPrompt(activeSessionId, prompt);
            }
            // noop
        },
        ...(opts?.compactContext
            ? {
                async compactContext(activeSessionId: string, command: string) {
                    return await opts.compactContext!(activeSessionId, command);
                },
            }
            : {}),
        async waitForResponseComplete(timeoutMs?: number | null) {
            if (opts?.waitForResponseComplete) {
                return await opts.waitForResponseComplete(timeoutMs);
            }
            // noop
        },
        async setSessionMode(activeSessionId: string, modeId: string) {
            if (opts?.setSessionMode) {
                return await opts.setSessionMode(activeSessionId, modeId);
            }
            return undefined;
        },
        async setSessionModel(activeSessionId: string, modelId: string) {
            if (opts?.setSessionModel) {
                return await opts.setSessionModel(activeSessionId, modelId);
            }
            return undefined;
        },
        async setSessionConfigOption(
            activeSessionId: string,
            configId: string,
            value: string | number | boolean | null,
        ) {
            if (opts?.setSessionConfigOption) {
                return await opts.setSessionConfigOption(activeSessionId, configId, value);
            }
            return undefined;
        },
        async cancel(activeSessionId: string) {
            if (opts?.cancel) {
                return await opts.cancel(activeSessionId);
            }
            // noop
        },
        async dispose() {
            if (opts?.dispose) {
                return await opts.dispose();
            }
            // noop
        },
        emit(msg: AgentMessage) {
            handler?.(msg);
        },
    };
}

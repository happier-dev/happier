import { vi } from 'vitest';

import * as acpModule from '@/agent/acp';
import type { AgentBackend, AgentMessageHandler, AgentSessionOpenOptions } from '@/agent/core';
import type { PermissionMode } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';

export type CatalogAcpRuntimeCreateCall = {
    agentId: string;
    permissionMode: PermissionMode | null | undefined;
    happierSessionId?: string | null;
    env?: NodeJS.ProcessEnv;
    appendSystemPromptText?: string;
};

export type CatalogAcpSessionOpenCall = Readonly<{
    initialPrompt?: string;
    options?: AgentSessionOpenOptions;
}>;

function createFakeBackend(id: number, sessionOpenCalls?: CatalogAcpSessionOpenCall[]): AgentBackend {
    let onMessageHandler: AgentMessageHandler | null = null;

    return {
        async startSession(initialPrompt, options) {
            sessionOpenCalls?.push({ initialPrompt, options });
            return { sessionId: `session-${id}` };
        },
        async sendPrompt() {},
        async cancel() {},
        onMessage(handler) {
            onMessageHandler = handler;
        },
        async dispose() {
            onMessageHandler = null;
        },
    };
}

export function createCatalogAcpBackendSpy(
    createCalls: CatalogAcpRuntimeCreateCall[],
    sessionOpenCalls?: CatalogAcpSessionOpenCall[],
) {
    return vi.spyOn(acpModule, 'createCatalogAcpBackend').mockImplementation(async (agentId, options) => {
        const catalogOptions = (options ?? {}) as {
            permissionMode?: PermissionMode | null;
            happierSessionId?: string | null;
            env?: NodeJS.ProcessEnv;
            appendSystemPromptText?: string;
        };
        createCalls.push({
            agentId,
            permissionMode: catalogOptions.permissionMode,
            ...(catalogOptions.happierSessionId !== undefined ? { happierSessionId: catalogOptions.happierSessionId } : {}),
            ...(catalogOptions.env !== undefined ? { env: catalogOptions.env } : {}),
            ...(catalogOptions.appendSystemPromptText !== undefined ? { appendSystemPromptText: catalogOptions.appendSystemPromptText } : {}),
        });

        return {
            backend: createFakeBackend(createCalls.length, sessionOpenCalls),
        } as unknown as Awaited<ReturnType<typeof acpModule.createCatalogAcpBackend>>;
    });
}

export function createMessageBufferFixture(): MessageBuffer {
    return new MessageBuffer();
}

export function createSessionProviderInputConsumerFixture(): SessionProviderInputConsumer<unknown, unknown> {
    return {
        waitForNextInput: vi.fn(async () => null),
        runProviderInputDispatch: vi.fn(async ({ dispatch }) => ({
            status: 'dispatched' as const,
            value: await dispatch(),
        })),
        closeProviderInputAdmissionAndWaitForDispatches: vi.fn(async () => undefined),
        drainPending: vi.fn(async () => ({ materialized: 0, stoppedReason: 'no_pending' as const })),
        pumpPendingWhileActive: vi.fn(async () => undefined),
    };
}

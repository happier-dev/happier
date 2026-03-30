import { vi } from 'vitest';

import * as acpModule from '@/agent/acp';
import type { AgentBackend, AgentMessageHandler } from '@/agent/core';
import type { PermissionMode } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

export type CatalogAcpRuntimeCreateCall = {
    agentId: string;
    permissionMode: PermissionMode | null | undefined;
};

function createFakeBackend(id: number): AgentBackend {
    let onMessageHandler: AgentMessageHandler | null = null;

    return {
        async startSession() {
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

export function createCatalogAcpBackendSpy(createCalls: CatalogAcpRuntimeCreateCall[]) {
    return vi.spyOn(acpModule, 'createCatalogAcpBackend').mockImplementation(async (agentId, options) => {
        const catalogOptions = (options ?? {}) as { permissionMode?: PermissionMode | null };
        createCalls.push({
            agentId,
            permissionMode: catalogOptions.permissionMode,
        });

        return {
            backend: createFakeBackend(createCalls.length),
        } as unknown as Awaited<ReturnType<typeof acpModule.createCatalogAcpBackend>>;
    });
}

export function createMessageBufferFixture(): MessageBuffer {
    return new MessageBuffer();
}

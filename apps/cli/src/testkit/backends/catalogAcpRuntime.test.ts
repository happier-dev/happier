import { afterEach, describe, expect, it, vi } from 'vitest';

import * as acpModule from '@/agent/acp';
import { createCatalogAcpBackendSpy, type CatalogAcpRuntimeCreateCall } from './catalogAcpRuntime';

describe('catalog ACP runtime testkit', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('records createCatalogAcpBackend calls through the canonical spy', async () => {
        const createCalls: CatalogAcpRuntimeCreateCall[] = [];
        createCatalogAcpBackendSpy(createCalls);

        const result = await acpModule.createCatalogAcpBackend('kimi', {
            permissionMode: 'read-only',
        });

        expect(createCalls).toEqual([
            {
                agentId: 'kimi',
                permissionMode: 'read-only',
            },
        ]);
        await expect(result.backend.startSession()).resolves.toEqual({
            sessionId: 'session-1',
        });
    });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => ({
                settings: {
                    acpCatalogSettingsV1: { v: 2, backends: [] },
                },
            }),
        },
    });
});

import { resolveExecutionRunBackendLabel } from './resolveExecutionRunBackendLabel';

describe('resolveExecutionRunBackendLabel', () => {
    it('projects built-in backend labels from the canonical agent display name instead of the raw id', () => {
        expect(resolveExecutionRunBackendLabel({
            kind: 'backend',
            backendId: 'codex',
        })).toBe('t:agentInput.agent.codex');
    });
});

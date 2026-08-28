import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

const ensureAgentInstallablesBackgroundMock = vi.hoisted(() => vi.fn(async () => {}));
const handleCreateSessionMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/capabilities/ensureAgentInstallablesBackground', () => ({
    ensureAgentInstallablesBackground: (params: unknown) => ensureAgentInstallablesBackgroundMock(params),
}));

vi.mock('@/components/sessions/new/hooks/useCreateNewSession', () => ({
    useCreateNewSession: () => ({
        handleCreateSession: handleCreateSessionMock,
        providerLaunchError: null,
        retryProviderLaunch: vi.fn(),
    }),
}));

import { useNewSessionCreateSessionAction } from './useNewSessionCreateSessionAction';

describe('useNewSessionCreateSessionAction', () => {
    beforeEach(() => {
        ensureAgentInstallablesBackgroundMock.mockClear();
        handleCreateSessionMock.mockClear();
    });

    it('prepares installables for the selected installed Agent operational identity', async () => {
        const params = {
            agentType: 'claude',
            runtimeCarrierAgentId: 'acme.review/assistant',
            staticAgentId: null,
            selectedMachineId: 'machine-b',
            resumeSessionId: null,
            settings: {},
            currentAuthoringDraft: {},
            allowedTargetServerIds: ['server-1'],
            resolvedSettingsAllowedServerIds: [],
            capabilityServerId: 'server-1',
        } as never;
        const hook = renderHook(() => useNewSessionCreateSessionAction(params));

        await hook.getCurrent().handleCreateSession();

        expect(ensureAgentInstallablesBackgroundMock).toHaveBeenCalledWith({
            agentId: 'acme.review/assistant',
            machineId: 'machine-b',
            serverId: 'server-1',
            settings: {},
            resumeSessionId: null,
        });
        expect(handleCreateSessionMock).toHaveBeenCalledTimes(1);
        hook.unmount();
    });
});

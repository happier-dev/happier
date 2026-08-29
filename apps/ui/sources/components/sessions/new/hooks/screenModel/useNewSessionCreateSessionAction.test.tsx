import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

const ensureAgentInstallablesBackgroundMock = vi.hoisted(() => vi.fn(async () => {}));
const handleCreateSessionMock = vi.hoisted(() => vi.fn(async () => {}));
const createSessionParamsSeen = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@/capabilities/ensureAgentInstallablesBackground', () => ({
    ensureAgentInstallablesBackground: (params: unknown) => ensureAgentInstallablesBackgroundMock(params),
}));

vi.mock('@/components/sessions/new/hooks/useCreateNewSession', () => ({
    useCreateNewSession: (params: unknown) => {
        createSessionParamsSeen.current = params;
        return {
            handleCreateSession: handleCreateSessionMock,
            providerLaunchError: null,
            retryProviderLaunch: vi.fn(),
        };
    },
}));

import { useNewSessionCreateSessionAction } from './useNewSessionCreateSessionAction';

describe('useNewSessionCreateSessionAction', () => {
    beforeEach(() => {
        ensureAgentInstallablesBackgroundMock.mockClear();
        handleCreateSessionMock.mockClear();
        createSessionParamsSeen.current = undefined;
    });

    it('prepares installables for the selected installed Agent operational identity', async () => {
        const pluginSettings = {
            account: { acmeBackendMode: 'turbo' },
        } as const;
        const params = {
            agentType: 'claude',
            runtimeCarrierAgentId: 'acme.review/assistant',
            staticAgentId: null,
            selectedMachineId: 'machine-b',
            resumeSessionId: null,
            settings: {},
            pluginSettings,
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
            pluginSettings,
            resumeSessionId: null,
        });
        expect(handleCreateSessionMock).toHaveBeenCalledTimes(1);
        expect(createSessionParamsSeen.current).toMatchObject({ pluginSettings });
        hook.unmount();
    });
});

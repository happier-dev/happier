import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useLocalSearchParamsMock = vi.fn();

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        params: useLocalSearchParamsMock(),
    });
    return expoRouterMock.module;
});

describe('legacy resume-browse route', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('redirects to the canonical resume picker route and normalizes the legacy query params', async () => {
        useLocalSearchParamsMock.mockReturnValue({
            providerId: ['claude', 'ignored'],
            machineId: ['machine-9', 'ignored'],
            serverId: ['server-4', 'ignored'],
            resumeSessionId: ['resume-123', 'ignored'],
            dataId: ['draft-7', 'ignored'],
            draftId: ['8e0a5dd1-b1df-43dd-b51e-b7787b30362e', 'ignored'],
        });

        const module = await import('@/app/(app)/new/pick/resume-browse');

        const screen = await renderScreen(React.createElement(module.default));

        const redirect = screen.findByType('Redirect' as any);
        expect(redirect.props.href).toEqual({
            pathname: '/new/pick/resume',
            params: {
                agentType: 'claude',
                machineId: 'machine-9',
                spawnServerId: 'server-4',
                dataId: 'draft-7',
                draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
                currentResumeId: 'resume-123',
            },
        });
    });
});

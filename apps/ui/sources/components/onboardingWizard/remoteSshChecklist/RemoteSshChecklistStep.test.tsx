import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const startSpy = vi.hoisted(() => vi.fn(async () => 'task-1'));

vi.mock('@/components/settings/machines/useRemoteSshBootstrapTask', () => ({
    useRemoteSshBootstrapTask: () => ({
        activeTaskSnapshot: null,
        answerPasswordPrompt: async () => undefined,
        cancel: async () => undefined,
        completedMachineId: null,
        continueAfterPrompt: async () => undefined,
        dismissPrompt: () => undefined,
        isStarting: false,
        prompt: null,
        resetPromptResolution: () => undefined,
        start: startSpy,
    }),
}));

describe('RemoteSshChecklistStep', () => {
    afterEach(() => {
        standardCleanup();
        startSpy.mockClear();
    });

    it('progresses from credentials to plan and starts remote bootstrap', async () => {
        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        let primary: { onPress: (() => void) | (() => Promise<void>); disabled: boolean } | null = null;

        const screen = await renderScreen(React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteRelayHost',
            relayUrl: 'https://relay.example.test',
            initialDraft: {
                username: 'dev',
                host: 'example.test',
            },
            onWizardPrimaryChange: (state) => {
                primary = state as any;
            },
        }));

        expect(screen.findByTestId('remote-ssh-step-ssh-sshUsernameInput')).toBeTruthy();
        expect(screen.findByTestId('remote-ssh-step-credentials-continue')).toBeNull();
        expect(primary).toBeTruthy();
        expect(primary?.disabled).toBe(false);

        await act(async () => {
            await (primary?.onPress as any)?.();
        });
        expect(screen.findByTestId('remote-ssh-step-plan')).toBeTruthy();
        expect(screen.findByTestId('remote-ssh-step-plan-continue')).toBeNull();
        expect(primary?.disabled).toBe(false);

        await act(async () => {
            await (primary?.onPress as any)?.();
        });

        expect(startSpy).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('remote-ssh-step-execution')).toBeTruthy();
    });
});

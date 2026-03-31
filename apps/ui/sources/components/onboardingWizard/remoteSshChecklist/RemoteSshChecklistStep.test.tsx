import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const startSpy = vi.hoisted(() => vi.fn(async () => 'task-1'));
const answerPasswordPromptSpy = vi.hoisted(() => vi.fn(async () => undefined));
const continueAfterPromptSpy = vi.hoisted(() => vi.fn(async () => undefined));
const dismissPromptSpy = vi.hoisted(() => vi.fn(() => undefined));
const hookState = vi.hoisted(() => ({
    prompt: null as any,
    isStarting: false,
    activeTaskSnapshot: null as any,
}));

vi.mock('@/components/settings/machines/useRemoteSshBootstrapTask', () => ({
    useRemoteSshBootstrapTask: () => ({
        activeTaskSnapshot: hookState.activeTaskSnapshot,
        answerPasswordPrompt: answerPasswordPromptSpy,
        cancel: async () => undefined,
        completedMachineId: null,
        continueAfterPrompt: continueAfterPromptSpy,
        dismissPrompt: dismissPromptSpy,
        isStarting: hookState.isStarting,
        prompt: hookState.prompt,
        resetPromptResolution: () => undefined,
        start: startSpy,
    }),
}));

describe('RemoteSshChecklistStep', () => {
    afterEach(() => {
        standardCleanup();
        startSpy.mockClear();
        answerPasswordPromptSpy.mockClear();
        continueAfterPromptSpy.mockClear();
        dismissPromptSpy.mockClear();
        hookState.prompt = null;
        hookState.isStarting = false;
        hookState.activeTaskSnapshot = null;
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

    it('uses wizard chrome actions for SSH password prompts', async () => {
        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        hookState.activeTaskSnapshot = { status: 'waiting', result: null, events: [] };

        let primary: { label?: string; onPress: (() => void) | (() => Promise<void>); disabled: boolean } | null = null;
        let skip: { label?: React.ReactNode; hidden?: boolean; disabled?: boolean; onPress?: () => void } | null = null;

        const element = React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteRelayHost',
            relayUrl: 'https://relay.example.test',
            initialDraft: {
                username: 'dev',
                host: 'example.test',
                authMode: 'password',
            },
            onWizardPrimaryChange: (state) => {
                primary = state as any;
            },
            onWizardSkipChange: (state) => {
                skip = state as any;
            },
        });

        const screen = await renderScreen(element);

        await act(async () => {
            await (primary?.onPress as any)?.();
        });
        await act(async () => {
            await (primary?.onPress as any)?.();
        });

        expect(startSpy).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('remote-ssh-step-execution')).toBeTruthy();

        hookState.prompt = {
            kind: 'ssh.password',
            message: 'Enter password',
            data: {},
        };

        await act(async () => {
            screen.tree.update(element);
        });

        expect(skip?.hidden).not.toBe(true);
        expect(primary?.disabled).toBe(true);
        expect(screen.findByTestId('remote-ssh-step-prompt-password')).toBeTruthy();

        await act(async () => {
            screen.changeTextByTestId('remote-ssh-step-prompt-password', 'hunter2');
        });
        expect(primary?.disabled).toBe(false);

        await act(async () => {
            await (primary?.onPress as any)?.();
        });

        expect(answerPasswordPromptSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            skip?.onPress?.();
        });
        expect(dismissPromptSpy).toHaveBeenCalledTimes(1);
    });
});

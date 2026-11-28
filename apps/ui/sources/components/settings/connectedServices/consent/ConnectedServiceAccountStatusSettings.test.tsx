import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { AlertButton } from '@/modal/types';
import { storage } from '@/sync/domains/state/storageStore';
import type { Settings } from '@/sync/domains/settings/settings';

import { ConnectedServiceAccountStatusSettings } from './ConnectedServiceAccountStatusSettings';

// The sync singleton pushes account settings to the server (system boundary); apply the delta locally.
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({
        applySettings: (delta: Partial<Settings>) => {
            storage.setState((state) => ({ ...state, settings: { ...state.settings, ...delta } }));
        },
    }),
}));

const openExternalUrl = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl }));

// The dialog is a platform boundary: answer it by pressing the next scripted button.
const dialog = vi.hoisted(() => ({ answers: [] as string[], messages: [] as Array<string | undefined> }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alertAsync: async (_title: string, message?: string, buttons?: AlertButton[]) => {
                dialog.messages.push(message);
                const answer = dialog.answers.shift();
                buttons?.find((button) => button.text === answer)?.onPress?.();
            },
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('ConnectedServiceAccountStatusSettings', () => {
    const previousState = storage.getState();
    afterEach(() => {
        storage.setState(previousState, true);
        dialog.answers = [];
        dialog.messages = [];
        standardCleanup();
    });

    it('turns on only after the account-status consent dialog is continued', async () => {
        const screen = await renderScreen(<ConnectedServiceAccountStatusSettings agentId="agy" />);
        const switchId = 'settings-provider-account-status:agy:switch';

        dialog.answers = ['connectedServices.accountStatusConsent.learnMore', 'common.cancel'];
        await act(async () => { await screen.tree.findByTestId(switchId)!.props.onValueChange(true); });
        expect(openExternalUrl).toHaveBeenCalledWith('https://antigravity.google/docs/faq');
        expect(dialog.messages).toEqual([
            'connectedServices.accountStatusConsent.noticeBody',
            'connectedServices.accountStatusConsent.noticeBody',
        ]);
        expect(storage.getState().settings.connectedServicesAccountStatusByAgentIdV1.agy).not.toBe(true);
        expect(screen.tree.findByTestId(switchId)!.props.value).toBe(false);

        dialog.answers = ['common.continue'];
        await act(async () => { await screen.tree.findByTestId(switchId)!.props.onValueChange(true); });
        expect(storage.getState().settings.connectedServicesAccountStatusByAgentIdV1).toEqual({ agy: true });

        // Turning it off needs no consent.
        await act(async () => { await screen.tree.findByTestId(switchId)!.props.onValueChange(false); });
        expect(dialog.messages).toHaveLength(3);
        expect(storage.getState().settings.connectedServicesAccountStatusByAgentIdV1).toEqual({ agy: false });
    });

    it('renders nothing for an agent without consent-gated account reads', async () => {
        const screen = await renderScreen(<ConnectedServiceAccountStatusSettings agentId="codex" />);
        expect(screen.tree.findByTestId('settings-provider-account-status:codex')).toBeNull();
    });
});

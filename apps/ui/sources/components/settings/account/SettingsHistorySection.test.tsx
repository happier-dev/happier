import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
    renderScreen,
} from '@/dev/testkit';

const fetchHistoryMock = vi.hoisted(() => vi.fn());
const restoreMock = vi.hoisted(() => vi.fn());
const storageStateMock = vi.hoisted(() => vi.fn(() => ({ settingsVersion: 12 })));

vi.mock('@/sync/api/account/apiAccountSettingsHistory', () => ({
    fetchAccountSettingsHistory: fetchHistoryMock,
}));

vi.mock('@/sync/engine/settings/accountSettingsHistoryRestore', () => {
    class AccountSettingsHistoryRestoreUnavailableError extends Error {
        readonly status: number;
        constructor(status: number, message: string) {
            super(message);
            this.name = 'AccountSettingsHistoryRestoreUnavailableError';
            this.status = status;
        }
    }
    class AccountSettingsHistoryRestoreInvalidError extends Error {
        constructor(reason: string) {
            super(`invalid (${reason})`);
            this.name = 'AccountSettingsHistoryRestoreInvalidError';
        }
    }
    return {
        AccountSettingsHistoryRestoreUnavailableError,
        AccountSettingsHistoryRestoreInvalidError,
        restoreAccountSettingsFromHistorySnapshot: restoreMock,
    };
});

vi.mock('@/sync/domains/state/storageStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storageStore')>();
    return {
        ...actual,
        storage: {
            getState: storageStateMock,
        },
    };
});

// Keep this Account-history surface test independent from generated Voice
// manifest artifacts owned by another build lane.
vi.mock('@/voice/registry/generatedBundledVoiceEntries', () => ({
    BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS: Object.freeze([]),
    BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS: Object.freeze([]),
}));

const modalSpies = vi.hoisted(() => ({
    confirm: vi.fn(async (_title?: string, _message?: string) => true),
    alert: vi.fn(async (_title?: string, _message?: string) => undefined),
}));

vi.mock('@/modal', () => ({ Modal: modalSpies }));

import { SettingsHistorySection } from './SettingsHistorySection';

const credentials = { token: 'token-1' } as never;

function historyResponse() {
    return {
        status: 'ready' as const,
        snapshots: [
            { version: 2, createdAt: '2026-08-28T10:00:00.000Z', contentKind: 'plain' as const, byteLength: 128 },
            { version: 3, createdAt: '2026-08-29T10:00:00.000Z', contentKind: 'encrypted' as const, byteLength: 256 },
        ],
    };
}

async function renderSection() {
    const screen = await renderScreen(
        <SettingsHistorySection credentials={credentials} encryption={null} />,
    );
    return screen;
}

describe('SettingsHistorySection', () => {
    beforeEach(() => {
        fetchHistoryMock.mockReset();
        restoreMock.mockReset();
        storageStateMock.mockClear();
        modalSpies.confirm.mockReset();
        modalSpies.confirm.mockResolvedValue(true);
        modalSpies.alert.mockReset();
        modalSpies.alert.mockResolvedValue(undefined);
        fetchHistoryMock.mockResolvedValue(historyResponse());
    });

    it('restores a selected snapshot through the one client-side restore owner and refreshes the list', async () => {
        restoreMock.mockResolvedValue({ status: 'applied', settingsVersion: 13 });
        const screen = await renderSection();

        await vi.waitFor(() => {
            expect(screen.findByTestId('settings-account-history-restore-3')).not.toBeNull();
        });
        expect(screen.findByTestId('settings-account-history-restore-2')).not.toBeNull();

        await screen.pressByTestIdAsync('settings-account-history-restore-3');

        expect(modalSpies.confirm).toHaveBeenCalled();
        expect(restoreMock).toHaveBeenCalledWith(expect.objectContaining({
            credentials,
            historyVersion: 3,
            expectedSettingsVersion: 12,
        }));
        await vi.waitFor(() => {
            expect(modalSpies.alert).toHaveBeenCalled();
        });
        // The section re-reads the existing history route after settlement.
        await vi.waitFor(() => {
            expect(fetchHistoryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        });
    });

    it('shows the truthful conflict outcome without rewriting history', async () => {
        restoreMock.mockResolvedValue({ status: 'conflict', currentSettingsVersion: 14 });
        const screen = await renderSection();
        await vi.waitFor(() => {
            expect(screen.findByTestId('settings-account-history-restore-3')).not.toBeNull();
        });

        await screen.pressByTestIdAsync('settings-account-history-restore-3');

        await vi.waitFor(() => {
            expect(modalSpies.alert).toHaveBeenCalled();
        });
        const alertArgs = modalSpies.alert.mock.calls[0]?.[1] as string | undefined;
        expect(alertArgs).toContain('14');
    });

    it('reports an unchanged settlement without claiming that it wrote settings', async () => {
        restoreMock.mockResolvedValue({ status: 'unchanged', settingsVersion: 12 });
        const screen = await renderSection();
        await vi.waitFor(() => {
            expect(screen.findByTestId('settings-account-history-restore-3')).not.toBeNull();
        });

        await screen.pressByTestIdAsync('settings-account-history-restore-3');

        await vi.waitFor(() => {
            expect(modalSpies.alert).toHaveBeenCalledWith(
                expect.any(String),
                'Your current account preferences already match the selected snapshot.',
            );
        });
    });

    it('never calls restore when the user cancels the confirmation', async () => {
        modalSpies.confirm.mockResolvedValue(false);
        const screen = await renderSection();
        await vi.waitFor(() => {
            expect(screen.findByTestId('settings-account-history-restore-2')).not.toBeNull();
        });

        await screen.pressByTestIdAsync('settings-account-history-restore-2');

        expect(restoreMock).not.toHaveBeenCalled();
    });

    it('reports an empty history without offering restore actions', async () => {
        fetchHistoryMock.mockResolvedValue({ status: 'ready', snapshots: [] });
        const screen = await renderSection();
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('No saved snapshots yet');
        });
        expect(screen.findByTestId('settings-account-history-restore-2')).toBeNull();
        expect(screen.findByTestId('settings-account-history-restore-3')).toBeNull();
    });
});

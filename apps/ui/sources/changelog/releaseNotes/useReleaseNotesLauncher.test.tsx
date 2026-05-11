import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

import { setLastSeenReleaseId } from './storage';

type ReleaseNotesModalProps = Readonly<{
    onComplete?: () => void;
    onDismiss?: () => void;
    onViewFullChangelog?: () => void;
}>;

type ReleaseNotesModalConfig = Readonly<{
    onRequestClose?: () => void;
    props?: ReleaseNotesModalProps;
}>;

const release = {
    releaseId: 'v1.0.0',
    versionLabel: 'v1.0.0',
    publishedAt: '2026-01-01T00:00:00.000Z',
    titleKey: 'releaseNotes.title',
    cards: [
        {
            kind: 'list' as const,
            titleKey: 'releaseNotes.card.title',
            rows: [{ iconId: 'sparkles', titleKey: 'releaseNotes.card.rowTitle', bodyKey: 'releaseNotes.card.rowBody' }],
        },
    ],
};

const modalState = vi.hoisted(() => ({
    lastConfig: null as ReleaseNotesModalConfig | null,
    lastProps: null as ReleaseNotesModalProps | null,
    show: vi.fn((config: ReleaseNotesModalConfig) => {
        modalState.lastConfig = config;
        modalState.lastProps = config.props ?? null;
        return 'release-notes-modal';
    }),
    hide: vi.fn(),
}));

const routerMock = createExpoRouterMock();
const originalEnv = { ...process.env };

vi.mock('expo-router', () => routerMock.module);

vi.mock('@/modal', () => ({
    Modal: {
        show: modalState.show,
        hide: modalState.hide,
    },
}));

vi.mock('@/components/changelog/releaseNotes', () => ({
    ReleaseNotesStorySurface: 'ReleaseNotesStorySurface',
}));

vi.mock('./manifestRuntime', () => ({
    getCurrentReleaseEntry: () => release,
    getActiveManifest: () => ({ schemaVersion: 'v1', generatedAt: '2026-01-01T00:00:00.000Z', releases: [release] }),
    getCurrentReleaseId: () => release.releaseId,
    findReleaseForId: () => release,
}));

describe('useReleaseNotesLauncher', () => {
    beforeEach(() => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = 'app.ui.releaseNotes';
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = '';
        setLastSeenReleaseId('v0.9.0');
        modalState.lastConfig = null;
        modalState.lastProps = null;
        modalState.show.mockClear();
        modalState.hide.mockClear();
        routerMock.spies.push.mockClear();
    });

    afterEach(() => {
        standardCleanup();
        process.env = { ...originalEnv };
    });

    async function renderLauncherAndUnread() {
        const { useReleaseNotesLauncher } = await import('./useReleaseNotesLauncher');
        const { useReleaseNotesUnread } = await import('./useReleaseNotesUnread');
        return renderHook(() => ({
            launcher: useReleaseNotesLauncher(),
            unread: useReleaseNotesUnread(),
        }));
    }

    it('clears unread state when the release story completes', async () => {
        const hook = await renderLauncherAndUnread();
        expect(hook.getCurrent().unread.hasUnread).toBe(true);

        expect(hook.getCurrent().launcher.open()).toBe(true);
        await act(async () => {
            modalState.lastProps?.onComplete?.();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent().unread.hasUnread).toBe(false);
        expect(modalState.hide).toHaveBeenCalledWith('release-notes-modal');

        await hook.unmount();
    });

    it('clears unread state when the release story is dismissed', async () => {
        const hook = await renderLauncherAndUnread();
        expect(hook.getCurrent().unread.hasUnread).toBe(true);

        expect(hook.getCurrent().launcher.open()).toBe(true);
        await act(async () => {
            modalState.lastProps?.onDismiss?.();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent().unread.hasUnread).toBe(false);

        await hook.unmount();
    });

    it('clears unread state when the modal backdrop dismisses the release story', async () => {
        const hook = await renderLauncherAndUnread();
        expect(hook.getCurrent().unread.hasUnread).toBe(true);

        expect(hook.getCurrent().launcher.open()).toBe(true);
        await act(async () => {
            modalState.lastConfig?.onRequestClose?.();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent().unread.hasUnread).toBe(false);
        expect(modalState.hide).toHaveBeenCalledWith('release-notes-modal');

        await hook.unmount();
    });

    it('clears unread state when opening the full changelog from the release story', async () => {
        const hook = await renderLauncherAndUnread();
        expect(hook.getCurrent().unread.hasUnread).toBe(true);

        expect(hook.getCurrent().launcher.open()).toBe(true);
        await act(async () => {
            modalState.lastProps?.onViewFullChangelog?.();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent().unread.hasUnread).toBe(false);
        expect(routerMock.spies.push).toHaveBeenCalledWith('/changelog');

        await hook.unmount();
    });

    it('does not open the release story when the release-notes feature is denied', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.ui.releaseNotes';
        const hook = await renderLauncherAndUnread();

        expect(hook.getCurrent().unread.hasUnread).toBe(false);
        expect(hook.getCurrent().launcher.open()).toBe(false);
        expect(modalState.show).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('does not open the release story without an explicit story allow', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = '';
        const hook = await renderLauncherAndUnread();

        expect(hook.getCurrent().unread.hasUnread).toBe(true);
        expect(hook.getCurrent().launcher.open()).toBe(false);
        expect(modalState.show).not.toHaveBeenCalled();

        await hook.unmount();
    });
});

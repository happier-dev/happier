import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { lightTheme } from '@/theme';
import { ComposerBannerCollapseProvider, useComposerBannerCollapse } from '@/components/sessions/composerBanners/ComposerBannerCollapseProvider';

const repositoryMocks = vi.hoisted(() => ({ resolve: vi.fn(async () => undefined) }));
const clipboardMocks = vi.hoisted(() => ({ copy: vi.fn(async () => true) }));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    return typeof style === 'object' && style !== null ? style as Record<string, unknown> : {};
}

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/ops/sessionDrafts/sessionDraftRepository')>()),
    resolveSessionDraftConflict: repositoryMocks.resolve,
}));
vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: clipboardMocks.copy }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('SessionDraftConflictResolution', () => {
    afterEach(() => {
        standardCleanup();
        repositoryMocks.resolve.mockClear();
        clipboardMocks.copy.mockClear();
    });

    it('delegates semantic resolution while copy mine remains non-mutating', async () => {
        const { SessionDraftConflictResolution } = await import('./SessionDraftConflictResolution');
        const scope = { serverId: 'server-a', accountId: 'account-a' };
        const address = { kind: 'session' as const, sessionId: 'session-a' };
        const screen = await renderScreen(
            <SessionDraftConflictResolution
                scope={scope}
                address={address}
                conflict={{
                    fields: [{
                        fieldId: 'composer.text',
                        path: { kind: 'composer', field: 'text' },
                        mine: 'Keep my local prompt',
                        synced: 'Use the remote prompt',
                    }],
                }}
            />,
        );

        expect(screen.findByTestId('session-draft-conflict:composer.text')).toBeTruthy();
        expect(screen.findByTestId('session-draft-conflict:composer.text')?.props).toMatchObject({
            role: 'alert',
            accessibilityLiveRegion: 'assertive',
        });
        expect(screen.root.findAll((node) => Boolean(node.props.accessibilityLiveRegion))).toHaveLength(1);

        const mineLabel = screen.root.findAll((node) => node.props.children === 'sessionDrafts.conflict.mine')[0];
        const syncedLabel = screen.root.findAll((node) => node.props.children === 'sessionDrafts.conflict.synced')[0];
        expect(flattenStyle(mineLabel?.props.style)).toMatchObject({ color: lightTheme.colors.state.warning.foreground });
        expect(flattenStyle(syncedLabel?.props.style)).toMatchObject({ color: lightTheme.colors.state.warning.foreground });

        const useSynced = screen.findByTestId('session-draft-conflict-action:composer.text:use-synced');
        const keepDevice = screen.findByTestId('session-draft-conflict-action:composer.text:keep-device');
        const copyMine = screen.findByTestId('session-draft-conflict-action:composer.text:copy-mine');
        expect(flattenStyle(useSynced?.props.style({ pressed: false }))).toMatchObject({
            backgroundColor: lightTheme.colors.button.primary.background,
        });
        expect(flattenStyle(keepDevice?.props.style({ pressed: false }))).toMatchObject({
            backgroundColor: lightTheme.colors.button.secondary.background,
        });
        expect(flattenStyle(copyMine?.findByType('Text' as React.ElementType).props.style)).toMatchObject({
            color: lightTheme.colors.text.secondary,
        });

        await act(async () => useSynced?.props.onPress());
        expect(repositoryMocks.resolve).toHaveBeenCalledWith({
            scope,
            address,
            fieldId: 'composer.text',
            action: 'useSynced',
        });

        await act(async () => screen.findByTestId('session-draft-conflict-action:composer.text:keep-device')?.props.onPress());
        expect(repositoryMocks.resolve).toHaveBeenLastCalledWith({
            scope,
            address,
            fieldId: 'composer.text',
            action: 'keepDevice',
        });

        repositoryMocks.resolve.mockClear();
        await act(async () => screen.findByTestId('session-draft-conflict-action:composer.text:copy-mine')?.props.onPress());
        expect(clipboardMocks.copy).toHaveBeenCalledWith('Keep my local prompt');
        expect(repositoryMocks.resolve).not.toHaveBeenCalled();
    });

    it('collapses only its own composer banner and resets for a materially new conflict', async () => {
        const { useSessionDraftConflictComposerBanner } = await import('./SessionDraftConflictResolution');
        const first = {
            fields: [{
                fieldId: 'composer.text',
                path: { kind: 'composer' as const, field: 'text' as const },
                mine: 'mine',
                synced: 'synced',
            }],
        };
        let conflict = first;

        function Harness() {
            const presentation = useSessionDraftConflictComposerBanner(conflict);
            const otherBanner = useComposerBannerCollapse('usageLimitRecovery');
            return React.createElement('ConflictState', {
                testID: 'conflict-state',
                collapsed: presentation.collapsed,
                expanded: presentation.statusBadge?.accessibilityState?.expanded,
                onClick: () => presentation.statusBadge?.onPress?.(),
                onDoubleClick: otherBanner.toggle,
            });
        }

        const screen = await renderScreen(
            <ComposerBannerCollapseProvider><Harness /></ComposerBannerCollapseProvider>,
        );
        const state = () => screen.findByTestId('conflict-state');
        expect(state()?.props.collapsed).toBe(false);

        act(() => state()?.props.onDoubleClick());
        expect(state()?.props.collapsed).toBe(false);

        act(() => state()?.props.onClick());
        expect(state()?.props.collapsed).toBe(true);
        expect(state()?.props.expanded).toBe(false);

        conflict = {
            fields: [{ ...first.fields[0], synced: 'new synced value' }],
        };
        await act(async () => screen.tree.update(
            <ComposerBannerCollapseProvider><Harness /></ComposerBannerCollapseProvider>,
        ));
        expect(state()?.props.collapsed).toBe(false);
    });
});

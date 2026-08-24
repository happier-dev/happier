import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ComposerBannerCollapseProvider, useComposerBannerCollapse } from '@/components/sessions/composerBanners/ComposerBannerCollapseProvider';

const repositoryMocks = vi.hoisted(() => ({
    resolve: vi.fn(async () => undefined),
}));
const clipboardMocks = vi.hoisted(() => ({
    copy: vi.fn(async () => true),
}));

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/ops/sessionDrafts/sessionDraftRepository')>()),
    resolveSessionDraftConflict: repositoryMocks.resolve,
}));
vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: clipboardMocks.copy }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

describe('SessionDraftConflictResolution', () => {
    afterEach(() => {
        standardCleanup();
        repositoryMocks.resolve.mockClear();
        clipboardMocks.copy.mockClear();
    });

    it('renders every conflicted field and delegates semantic choices while copy mine stays non-mutating', async () => {
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

        await act(async () => screen.findByTestId('session-draft-conflict-action:composer.text:use-synced')?.props.onPress());
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

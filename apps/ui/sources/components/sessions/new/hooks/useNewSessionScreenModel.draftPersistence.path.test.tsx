import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import {
    persistDraftNowRef,
    persistedDraft,
    renderNewSessionScreenModel,
    repoSnapshotState,
    resetDraftPersistenceState,
    routerPushMock,
    routerSetParamsMock,
    saveNewSessionDraftMock,
    searchParamsState,
    useCreateNewSessionArgsRef,
    useNewSessionScreenModelModulePromise,
} from './__tests__/draftPersistenceTestEnvironment';
import { findCheckoutChip, getCheckoutChipLabel } from './__tests__/checkoutChipSelectors';

/**
 * Path-domain draft-persistence behavior:
 * - Shared path popover surface (route stability, migrated content tree).
 * - FR3-10 invariant: opening the tree-browser modal must NOT pre-close the
 *   path popover.
 * - Workspace linkage clearing when the selected path changes (route param
 *   updates, canonical `directory` route param, string-array params).
 */
describe('useNewSessionScreenModel (draft hydration — path)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        resetDraftPersistenceState();
    });

    it('keeps the current route stable and exposes a shared path popover when the new-session route starts without a dataId', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        expect(model?.simpleProps?.handlePathClick).toBeUndefined();
        expect(typeof model?.simpleProps?.pathPopover?.renderContent).toBe('function');
        expect(routerSetParamsMock).not.toHaveBeenCalled();
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('routes the path popover to the migrated PathSelectionList content surface', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        // Phase 11: the path popover's renderContent now returns a
        // <NewSessionPathSelectionContent> tree wired to onCommit (no
        // intermediate keystroke callbacks). Assert structurally without
        // actually mounting the deep tree — mounting triggers the dynamic
        // IN THIS FOLDER section's real RPC and leaks fetch state across
        // tests in this shared-state suite.
        const content = model?.simpleProps?.pathPopover?.renderContent?.({
            requestClose: () => {},
        });
        expect(content).toBeTruthy();
        const element = content as React.ReactElement;
        expect(typeof element.type).toBe('function');
        expect((element.type as { name?: string }).name).toBe('NewSessionPathSelectionContent');
        expect((element.props as { onCommit?: unknown }).onCommit).toBeInstanceOf(Function);
        expect((element.props as { initialSuggestionMode?: unknown }).initialSuggestionMode).toBe('history');
        expect((element.props as { onSubmitSelectedPath?: unknown }).onSubmitSelectedPath).toBeUndefined();
    });

    it('lets the migrated PathSelectionList own path popover scrolling and edge fades', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        expect(model?.simpleProps?.pathPopover?.scrollEnabled).toBe(false);
        expect(model?.simpleProps?.pathPopover?.edgeFades).toBeUndefined();
        expect(model?.simpleProps?.pathPopover?.edgeIndicators).toBeUndefined();
        expect(model?.simpleProps?.pathPopover?.initialVisibility).toBeUndefined();
    });

    // FR3-10: opening the tree-browser modal from the path popover MUST preserve
    // popover state. Previously the model passed `requestClose` as
    // `onBeforeBrowseMachinePath`, which awaited a pre-close before opening the
    // modal — destroying the popover state so the user could not return to it
    // when the modal was dismissed. Per the plan (§363), the popover must remain
    // mounted underneath; the modal renders on top.
    it('FR3-10: does NOT pre-close the path popover before opening the tree-browser modal', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        const requestClose = vi.fn();
        const content = model?.simpleProps?.pathPopover?.renderContent?.({
            requestClose,
        });
        expect(content).toBeTruthy();
        const element = content as React.ReactElement;
        const props = element.props as { onBeforeBrowseMachinePath?: unknown };
        expect(props.onBeforeBrowseMachinePath).not.toBe(requestClose);
        expect(props.onBeforeBrowseMachinePath).toBeUndefined();
    });

    it('clears stale workspace linkage after the selected path changes to an unrelated route path', async () => {
        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();

        searchParamsState.value = {
            machineId: 'machine-2',
            path: '/repo/unlinked',
        };

        await hook.rerender();

        expect(model?.simpleProps?.selectedPath).toBe('/repo/unlinked');
        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                directory: '/repo/unlinked',
            }),
        }));

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            selectedMachineId: 'machine-2',
            selectedPath: '/repo/unlinked',
        }));
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).not.toEqual(expect.objectContaining({
            selectedWorkspaceId: expect.anything(),
        }));
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).not.toEqual(expect.objectContaining({
            selectedWorkspaceLocationId: expect.anything(),
        }));
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).not.toEqual(expect.objectContaining({
            selectedWorkspaceCheckoutId: expect.anything(),
        }));
    });

    it('keeps repo-native path and worktree chip visible when machine/path route params arrive as string arrays', async () => {
        searchParamsState.value = {
            machineId: ['machine-2'],
            path: ['/repo/unlinked'],
        };
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;
        repoSnapshotState.value = {
            ...repoSnapshotState.value,
            projectKey: 'machine-2:/repo/unlinked',
            repo: {
                ...repoSnapshotState.value.repo,
                rootPath: '/repo/unlinked',
                worktrees: [
                    { path: '/repo/unlinked', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/unlinked-feature', branch: 'feature/demo', isCurrent: false },
                ],
            },
        };
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        expect(model?.simpleProps?.selectedPath).toBe('/repo/unlinked');
        expect(findCheckoutChip(model)).toBeTruthy();
        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');
    });

    it('hydrates the selected path from the canonical directory route param', async () => {
        searchParamsState.value = {
            machineId: 'machine-2',
            directory: '/repo/from-directory',
        };
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;
        repoSnapshotState.value = {
            ...repoSnapshotState.value,
            projectKey: 'machine-2:/repo/from-directory',
            repo: {
                ...repoSnapshotState.value.repo,
                rootPath: '/repo/from-directory',
            },
        };
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        expect(model?.simpleProps?.selectedPath).toBe('/repo/from-directory');
    });
});

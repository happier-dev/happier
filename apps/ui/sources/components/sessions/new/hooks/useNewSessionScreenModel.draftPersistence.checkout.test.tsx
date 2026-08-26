import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

import {
    modalShowMock,
    notifyMockStorageSubscribers,
    persistDraftNowRef,
    persistedDraft,
    platformOsState,
    renderNewSessionScreenModel,
    replaceRepositoryDraftFromPersistedFixture,
    repoSnapshotState,
    resetDraftPersistenceState,
    routerPushMock,
    runFocusEffectsAndSettle,
    saveNewSessionDraftMock,
    searchParamsState,
    TEST_DRAFT_ID,
    targetServerState,
    useNewSessionScreenModelModulePromise,
    workspaceGraphState,
} from './__tests__/draftPersistenceTestEnvironment';
import {
    findCheckoutChip,
    getCheckoutChipCollapsedPopover,
    getCheckoutChipExistingWorktreeIds,
    getCheckoutChipLabel,
    getCheckoutChipQuickActionIds,
    getCheckoutChipStaticSection,
} from './__tests__/checkoutChipSelectors';

/**
 * Checkout-domain draft-persistence behavior: the checkout chip
 * (`new-session-checkout`) and its SelectionList-driven worktree picker.
 *
 * Covers focus rehydration of checkout selection, in-memory mutation
 * persistence, worktree picker open semantics across platforms, route-driven
 * picker auto-open, base-ref selection commit-only-on-apply, workspace
 * graph reactivity, and target-server-scoped fail-closed behavior.
 */
describe('useNewSessionScreenModel (draft hydration — checkout)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(async () => {
        await resetDraftPersistenceState();
    });

    it('re-hydrates the worktree checkout selection when a newer draft is loaded on focus', async () => {
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;
        persistedDraft.updatedAt = 123;

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');

        persistedDraft.selectedWorkspaceId = 'ws_payments';
        persistedDraft.selectedWorkspaceLocationId = 'loc_local';
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = {
            kind: 'git_worktree',
            displayName: 'feature/focused-browser-fix',
            baseRef: 'main',
        };
        persistedDraft.updatedAt = 456;
        await replaceRepositoryDraftFromPersistedFixture();

        const cleanups = await runFocusEffectsAndSettle();
        for (const cleanup of cleanups) {
            if (typeof cleanup === 'function') cleanup();
        }

        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(model?.simpleProps?.checkoutCreationDraft).toMatchObject({
            kind: 'git_worktree',
            displayName: 'feature/focused-browser-fix',
            baseRef: 'main',
        });
        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.newWorktree: feature/focused-browser-fix');
    });

    it('persists updated checkout creation draft state after in-memory changes', async () => {
        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => { model = nextModel; });

        await act(async () => {
            model?.simpleProps?.setCheckoutCreationDraft?.({
                kind: 'git_worktree',
                displayName: 'feature/payment-sync',
                baseRef: 'develop',
            });
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/payment-sync',
                baseRef: 'develop',
            },
        }));
    });

    it('fails closed back to the inferred workspace selection after invalid in-memory changes', async () => {
        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => { model = nextModel; });

        expect(model?.simpleProps?.setSelectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.setSelectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.setSelectedWorkspaceCheckoutId).toBeUndefined();

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            selectedMachineId: 'machine-2',
            selectedPath: '/repo/custom',
        }));
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.not.objectContaining({
            selectedWorkspaceId: expect.anything(),
            selectedWorkspaceLocationId: expect.anything(),
            selectedWorkspaceCheckoutId: expect.anything(),
        }));
    });

    it('surfaces a checkout chip that opens the worktree picker from an unlinked git repo', async () => {
        persistedDraft.checkoutCreationDraft = null;
        workspaceGraphState.workspacesByServerId['server-a'] = [];
        workspaceGraphState.workspaceLocations = {};
        workspaceGraphState.workspaceCheckouts = {};
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel({ draftId: TEST_DRAFT_ID }); return null; };

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            model?.simpleProps?.setCheckoutCreationDraft?.(null);
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        const checkoutChip = findCheckoutChip(model);
        expect(checkoutChip).toBeTruthy();
        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');

        const pickerPopover = getCheckoutChipCollapsedPopover(model);
        expect(pickerPopover).toEqual(expect.objectContaining({
            title: 'newSession.checkout.selectTitle',
            label: 'newSession.checkout.noWorktree',
            presentation: 'list',
        }));
        expect(getCheckoutChipQuickActionIds(model)).toEqual([
            'current_path',
            'create_git_worktree',
        ]);

        const toggleCollapsedPopover = vi.fn();
        const screen = await renderScreen(
            React.createElement(React.Fragment, null, checkoutChip!.render({
                chipStyle: () => null,
                showLabel: true,
                iconColor: '#000',
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null },
                chipAnchorRef: { current: null },
                toggleCollapsedPopover,
            })),
        );
        screen.pressByTestId('new-session-checkout-chip');
        expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-checkout');
    });

    it('exposes the worktree picker when the route explicitly requests a new worktree flow', async () => {
        persistedDraft.checkoutCreationDraft = null;
        workspaceGraphState.workspacesByServerId['server-a'] = [];
        workspaceGraphState.workspaceLocations = {};
        workspaceGraphState.workspaceCheckouts = {};
        searchParamsState.value = {
            worktree: 'new',
        };
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel({ draftId: TEST_DRAFT_ID }); return null; };

        await renderScreen(React.createElement(Probe));

        const checkoutChip = findCheckoutChip(model);
        expect(checkoutChip).toBeTruthy();

        const pickerPopover = getCheckoutChipCollapsedPopover(model);
        expect(pickerPopover?.presentation).toBe('list');
        expect(getCheckoutChipQuickActionIds(model)).toEqual([
            'current_path',
            'create_git_worktree',
        ]);
    });

    it('uses the shared checkout picker popover on ios when checkout options require a picker', async () => {
        platformOsState.value = 'ios';
        persistedDraft.checkoutCreationDraft = null;
        workspaceGraphState.workspacesByServerId['server-a'] = [
            {
                ...workspaceGraphState.workspacesByServerId['server-a'][0],
                checkoutIds: ['checkout_feature_auth', 'checkout_release', 'checkout_hotfix'],
                defaultCheckoutId: 'checkout_feature_auth',
            },
        ];
        workspaceGraphState.workspaceCheckouts = {
            checkout_feature_auth: {
                id: 'checkout_feature_auth',
                workspaceId: 'ws_payments',
                workspaceLocationId: 'loc_local',
                kind: 'primary',
                path: '/repo/custom',
                displayName: 'main',
                status: 'ready',
                syncPolicy: 'inherit',
                scm: {
                    git: {
                        branch: 'main',
                        isMainWorktree: true,
                        mainRepoPath: '/repo/custom',
                    },
                },
            },
            checkout_release: {
                id: 'checkout_release',
                workspaceId: 'ws_payments',
                workspaceLocationId: 'loc_local',
                kind: 'git_worktree',
                path: '/repo/release',
                displayName: 'release',
                status: 'ready',
                syncPolicy: 'inherit',
                scm: {
                    git: {
                        branch: 'release',
                        isMainWorktree: false,
                        mainRepoPath: '/repo/custom',
                    },
                },
            },
            checkout_hotfix: {
                id: 'checkout_hotfix',
                workspaceId: 'ws_payments',
                workspaceLocationId: 'loc_local',
                kind: 'git_worktree',
                path: '/repo/hotfix',
                displayName: 'hotfix',
                status: 'ready',
                syncPolicy: 'inherit',
                scm: {
                    git: {
                        branch: 'hotfix',
                        isMainWorktree: false,
                        mainRepoPath: '/repo/custom',
                    },
                },
            },
        };
        repoSnapshotState.value = {
            ...repoSnapshotState.value,
            repo: {
                ...repoSnapshotState.value.repo,
                worktrees: [
                    { path: '/repo/custom', branch: 'main', isCurrent: true },
                    { path: '/repo/hotfix', branch: 'hotfix', isCurrent: false },
                    { path: '/repo/release', branch: 'release', isCurrent: false },
                ],
            },
        };
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel({ draftId: TEST_DRAFT_ID }); return null; };

        await renderScreen(React.createElement(Probe));

        const checkoutChip = findCheckoutChip(model);
        expect(checkoutChip).toBeTruthy();
        expect(checkoutChip?.controlId).toBe('checkout');
        expect(checkoutChip?.collapsedOptionsPopover?.title).toBe('newSession.checkout.selectTitle');
        expect(modalShowMock).not.toHaveBeenCalled();
        const quickActionIds = getCheckoutChipQuickActionIds(model);
        expect(quickActionIds).toContain('current_path');
        expect(getCheckoutChipExistingWorktreeIds(model).length).toBeGreaterThan(0);

        const toggleCollapsedPopover = vi.fn();
        const screen = await renderScreen(
            React.createElement(React.Fragment, null, checkoutChip!.render({
                chipStyle: () => null,
                showLabel: true,
                iconColor: '#000',
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null },
                chipAnchorRef: { current: null },
                toggleCollapsedPopover,
            })),
        );
        screen.pressByTestId('new-session-checkout-chip');
        expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-checkout');
    });

    it('opens the shared checkout picker when an existing repo worktree is available without workspace linkage', async () => {
        persistedDraft.checkoutCreationDraft = null;
        workspaceGraphState.workspacesByServerId['server-a'] = [];
        workspaceGraphState.workspaceLocations = {};
        workspaceGraphState.workspaceCheckouts = {};
        repoSnapshotState.value = {
            ...repoSnapshotState.value,
            repo: {
                ...repoSnapshotState.value.repo,
                worktrees: [
                    { path: '/repo/custom', branch: 'main', isCurrent: true },
                    { path: '/repo/release', branch: 'release', isCurrent: false },
                ],
            },
        };

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel({ draftId: TEST_DRAFT_ID }); return null; };

        await renderScreen(React.createElement(Probe));

        const checkoutChip = findCheckoutChip(model);
        expect(checkoutChip).toBeTruthy();
        expect(getCheckoutChipCollapsedPopover(model)?.presentation).toBe('list');

        const toggleCollapsedPopover = vi.fn();
        const screen = await renderScreen(
            React.createElement(React.Fragment, null, checkoutChip!.render({
                chipStyle: () => null,
                showLabel: true,
                iconColor: '#000',
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null },
                chipAnchorRef: { current: null },
                toggleCollapsedPopover,
            })),
        );
        screen.pressByTestId('new-session-checkout-chip');
        expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-checkout');

        // The unlinked-repo case surfaces the canonical quick-actions
        // (current path + create-worktree) and at least one existing-worktree
        // row (the non-current `/repo/release`).
        expect(getCheckoutChipQuickActionIds(model)).toEqual([
            'current_path',
            'create_git_worktree',
        ]);
        expect(getCheckoutChipExistingWorktreeIds(model).length).toBeGreaterThan(0);
    });

    it('commits the selected new-worktree base ref only when the picker apply action runs', async () => {
        persistedDraft.checkoutCreationDraft = null;
        workspaceGraphState.workspacesByServerId['server-a'] = [];
        workspaceGraphState.workspaceLocations = {};
        workspaceGraphState.workspaceCheckouts = {};
        // Only the current-dir worktree exists; the synthesised remote branch
        // row ("origin/release") must NOT have a matching local worktree, so
        // the builder routes through the "name your worktree" step (new worktree
        // path, committed via `onCreateWorktreeWithName`) rather than
        // `onReuseExistingWorktreeForBranch`.
        repoSnapshotState.value = {
            ...repoSnapshotState.value,
            repo: {
                ...repoSnapshotState.value.repo,
                worktrees: [
                    { path: '/repo/custom', branch: 'main', isCurrent: true },
                ],
            },
        };

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel({ draftId: TEST_DRAFT_ID }); return null; };

        await renderScreen(React.createElement(Probe));

        const quickActions = getCheckoutChipStaticSection(model, 'worktree:quick-actions');
        const createOption = quickActions?.options.find((option) => option.id === 'create_git_worktree');

        expect(createOption).toBeTruthy();
        expect(createOption?.openStep?.id).toBe('worktree-create');
        expect(model?.simpleProps?.checkoutCreationDraft).toBeNull();
        // The default-fixture screen model exposes the in-memory setter; we
        // need it to bridge the synthesised branch row's onSelect into the
        // production state slot.
        expect(typeof model?.simpleProps?.setCheckoutCreationDraft).toBe('function');

        // The SelectionList drill-down step exposes branch rows. Choosing a branch
        // with no existing worktree opens the value-mode "name your worktree" step;
        // committing that step fires the create path. Tests synthesise a remote-branch
        // row via the builder helper so we don't depend on the live RPC fetch inside
        // the dynamic section resolver.
        const { buildWorktreeBranchOption } = await import('@/components/sessions/new/hooks/screenModel/buildWorktreeSelectionListSteps');
        const remoteBranchOption = buildWorktreeBranchOption({
            branch: { name: 'origin/release', type: 'remote', upstream: null },
            snapshot: repoSnapshotState.value,
            currentDirPath: '/repo/custom',
            rowIconColor: '#999',
            worktreeNameSuggestion: 'feature-x',
            onCreateWorktreeWithName: (selection) => {
                model?.simpleProps?.setCheckoutCreationDraft?.({
                    kind: 'git_worktree',
                    displayName: selection.name,
                    baseRef: selection.baseRef,
                    branchMode: 'new',
                });
            },
            onReuseExistingWorktreeForBranch: () => {},
        });

        await act(async () => {
            remoteBranchOption.openStep?.onCommitInputValue?.('feature-x');
            await flushHookEffects({ cycles: 3, turns: 2 });
        });

        expect(model?.simpleProps?.checkoutCreationDraft).toEqual({
            kind: 'git_worktree',
            displayName: expect.any(String),
            baseRef: 'origin/release',
            branchMode: 'new',
        });
    });

    it('reacts to workspace graph updates without requiring an unrelated rerender', async () => {
        workspaceGraphState.workspaceLocations = {};
        workspaceGraphState.workspaceCheckouts = {};
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel({ draftId: TEST_DRAFT_ID }); return null; };

        await renderScreen(React.createElement(Probe));

        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');
        const getCheckoutChipRef = () => findCheckoutChip(model);
        expect(getCheckoutChipRef()?.controlId).toBe('checkout');
        expect(getCheckoutChipRef()?.collapsedOptionsPopover?.title).toBe('newSession.checkout.selectTitle');
        const initialOptionIds = getCheckoutChipQuickActionIds(model);
        expect(initialOptionIds).toEqual([
            'current_path',
            'create_git_worktree',
        ]);

        await act(async () => {
            workspaceGraphState.workspaceLocations = {
                loc_local: {
                    id: 'loc_local',
                    workspaceId: 'ws_payments',
                    machineId: 'machine-2',
                    path: '/repo/custom',
                    detectedScm: {
                        provider: 'git',
                        rootPath: '/repo/custom',
                    },
                    capabilities: {
                        syncEligible: true,
                        scmDetected: true,
                        checkoutProviderKinds: ['git_worktree'],
                    },
                },
            };
            workspaceGraphState.workspaceCheckouts = {
                checkout_feature_auth: {
                    id: 'checkout_feature_auth',
                    workspaceId: 'ws_payments',
                    workspaceLocationId: 'loc_local',
                    kind: 'primary',
                    path: '/repo/custom',
                    displayName: 'main',
                    status: 'ready',
                    syncPolicy: 'inherit',
                    scm: {
                        git: {
                            branch: 'main',
                            isMainWorktree: true,
                            mainRepoPath: '/repo/custom',
                        },
                    },
                },
            };
            notifyMockStorageSubscribers();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');
        const updatedOptionIds = getCheckoutChipQuickActionIds(model);
        expect(updatedOptionIds).toEqual([
            'current_path',
            'create_git_worktree',
        ]);
    });

    it('does not surface workspace creation in the checkout chip when the selected path is not yet linked', async () => {
        persistedDraft.selectedMachineId = 'machine-2';
        persistedDraft.selectedPath = '/repo/unlinked';
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;
        workspaceGraphState.workspacesByServerId['server-a'] = [];
        workspaceGraphState.workspaceLocations = {};
        workspaceGraphState.workspaceCheckouts = {};

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel({ draftId: TEST_DRAFT_ID }); return null; };

        await renderScreen(React.createElement(Probe));

        const chip = findCheckoutChip(model);
        expect(chip).toBeTruthy();
        expect(chip?.controlId).toBe('checkout');
        expect(chip?.collapsedOptionsPopover?.title).toBe('newSession.checkout.selectTitle');

        // The checkout chip exposes its pickable options via `collapsedOptionsPopover.rootStep`.
        const optionIds = getCheckoutChipQuickActionIds(model);
        expect(optionIds).toEqual([
            'current_path',
            'create_git_worktree',
        ]);
        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('fails closed to the selected target server workspace graph when another server owns the matching checkout path', async () => {
        targetServerState.allowedTargetServerIds = ['server-a', 'server-b'];
        targetServerState.targetServerId = 'server-b';
        targetServerState.targetServerName = 'Server B';
        persistedDraft.selectedMachineId = 'machine-2';
        persistedDraft.selectedPath = '/repo/custom';
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel({ draftId: TEST_DRAFT_ID }); return null; };

        await renderScreen(React.createElement(Probe));

        const chip = findCheckoutChip(model);
        expect(chip?.controlId).toBe('checkout');
        expect(chip?.collapsedOptionsPopover?.title).toBe('newSession.checkout.selectTitle');

        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');

        expect(chip).toBeTruthy();

        const optionIds = getCheckoutChipQuickActionIds(model);
        expect(optionIds).toEqual([
            'current_path',
            'create_git_worktree',
        ]);
    });
});

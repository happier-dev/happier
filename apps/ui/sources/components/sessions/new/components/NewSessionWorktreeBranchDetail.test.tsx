import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';


globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fetchBranchesForMachinePathMock = vi.hoisted(() => vi.fn());
const readCachedBranchesForMachinePathMock = vi.hoisted(() => vi.fn());

installNewSessionComponentsCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => {
                if (key === 'files.branchMenu.branch.upstream') {
                    return `Upstream: ${String(params?.upstream ?? '')}`;
                }

                return key;
            },
        });
    },
});

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
    OptionPickerOverlay: (props: Record<string, unknown>) => React.createElement('OptionPickerOverlay', props),
}));

vi.mock('@/scm/repository/repoScmBranchService', () => ({
    repoScmBranchService: {
        fetchBranchesForMachinePath: fetchBranchesForMachinePathMock,
        readCachedBranchesForMachinePath: readCachedBranchesForMachinePathMock,
    },
}));

describe('NewSessionWorktreeBranchDetail', () => {
    beforeEach(() => {
        readCachedBranchesForMachinePathMock.mockReturnValue([]);
    });

    afterEach(() => {
        fetchBranchesForMachinePathMock.mockReset();
        readCachedBranchesForMachinePathMock.mockReset();
        readCachedBranchesForMachinePathMock.mockReturnValue([]);
    });

    it('loads repo branches through the canonical repo branch service and prepends the current-head option', async () => {
        fetchBranchesForMachinePathMock.mockResolvedValue([
            { name: 'feature/auth', type: 'local', isCurrent: false, upstream: null },
            { name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' },
            { name: 'origin/release', type: 'remote', isCurrent: false, upstream: null },
        ]);

        const { NewSessionWorktreeBranchDetail } = await import('./NewSessionWorktreeBranchDetail');

        const screen = await renderScreen(<NewSessionWorktreeBranchDetail
                    machineId="machine-a"
                    path="~/repo"
                    selectedBaseRef={null}
                    onSelectionChange={() => {}}
                />);

        const overlay = screen.findByType('OptionPickerOverlay' as any);
        expect(fetchBranchesForMachinePathMock).toHaveBeenCalledWith({
            machineId: 'machine-a',
            path: '~/repo',
            includeRemotes: true,
        });
        expect(overlay.props.selectedValue).toBe('__repo_head__');
        expect(overlay.props.searchPlaceholder).toBe('newSession.checkout.branchPickerSearchPlaceholder');
        expect(overlay.props.probe).toEqual(expect.objectContaining({
            phase: 'idle',
            refreshAccessibilityLabel: 'newSession.checkout.branchPickerRefreshA11y',
            loadingAccessibilityLabel: 'newSession.checkout.branchPickerLoadingA11y',
            refreshingAccessibilityLabel: 'newSession.checkout.branchPickerRefreshingA11y',
        }));
        expect(overlay.props.options).toEqual([
            expect.objectContaining({
                value: '__repo_head__',
                label: 'newSession.checkout.branchPickerCurrentHead',
            }),
            expect.objectContaining({
                value: 'feature/auth',
                label: 'feature/auth',
            }),
            expect.objectContaining({
                value: 'main',
                label: 'main',
                description: 'Upstream: origin/main',
            }),
            expect.objectContaining({
                value: 'origin/release',
                label: 'origin/release',
                description: 'files.branchMenu.category.remote',
            }),
        ]);
    });

    it('maps the current-head sentinel and branch selections back to baseRef updates', async () => {
        fetchBranchesForMachinePathMock.mockResolvedValue([
            { name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' },
        ]);

        const onSelectionChange = vi.fn();
        const { NewSessionWorktreeBranchDetail } = await import('./NewSessionWorktreeBranchDetail');

        const screen = await renderScreen(<NewSessionWorktreeBranchDetail
                    machineId="machine-a"
                    path="/repo"
                    selectedBaseRef="main"
                    onSelectionChange={onSelectionChange}
                />);

        const overlay = screen.findByType('OptionPickerOverlay' as any);
        await act(async () => {
            overlay.props.onSelect('__repo_head__');
            overlay.props.onSelect('main');
        });

        expect(onSelectionChange).toHaveBeenNthCalledWith(1, {
            baseRef: null,
            sourceKind: 'current',
        });
        expect(onSelectionChange).toHaveBeenNthCalledWith(2, {
            baseRef: 'main',
            sourceKind: 'local',
        });
    });

    it('seeds the picker from the shared branch cache before refreshing', async () => {
        readCachedBranchesForMachinePathMock.mockReturnValue([
            { name: 'cached/main', type: 'local', isCurrent: true, upstream: null },
        ]);
        fetchBranchesForMachinePathMock.mockImplementation(() => new Promise(() => {}));

        const { NewSessionWorktreeBranchDetail } = await import('./NewSessionWorktreeBranchDetail');

        const screen = await renderScreen(<NewSessionWorktreeBranchDetail
                    machineId="machine-a"
                    path="~/repo"
                    selectedBaseRef={null}
                    onSelectionChange={() => {}}
                />);

        const overlay = screen.findByType('OptionPickerOverlay' as any);
        expect(overlay.props.options).toEqual([
            expect.objectContaining({
                value: '__repo_head__',
            }),
            expect.objectContaining({
                value: 'cached/main',
                label: 'cached/main',
            }),
        ]);
        expect(fetchBranchesForMachinePathMock).toHaveBeenCalledWith({
            machineId: 'machine-a',
            path: '~/repo',
            includeRemotes: true,
        });
    });

    it('keeps cached branches visible when the refresh fails', async () => {
        readCachedBranchesForMachinePathMock.mockReturnValue([
            { name: 'cached/main', type: 'local', isCurrent: true, upstream: null },
        ]);
        fetchBranchesForMachinePathMock.mockRejectedValue(new Error('refresh failed'));

        const { NewSessionWorktreeBranchDetail } = await import('./NewSessionWorktreeBranchDetail');

        const screen = await renderScreen(<NewSessionWorktreeBranchDetail
                    machineId="machine-a"
                    path="~/repo"
                    selectedBaseRef={null}
                    onSelectionChange={() => {}}
                />);

        const overlay = screen.findByType('OptionPickerOverlay' as any);
        expect(overlay.props.options).toEqual([
            expect.objectContaining({
                value: '__repo_head__',
            }),
            expect.objectContaining({
                value: 'cached/main',
                label: 'cached/main',
            }),
        ]);
    });
});

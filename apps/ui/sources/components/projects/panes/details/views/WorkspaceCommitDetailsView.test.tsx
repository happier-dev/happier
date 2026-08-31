import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { machineScmDiffCommit } from '@/sync/ops/scm/machineScm';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MachineScmDiffCommit = typeof machineScmDiffCommit;

const machineScmDiffCommitSpy = vi.fn<MachineScmDiffCommit>(async () => ({
    success: true,
    diff: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
    ].join('\n'),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useSetting: () => false,
    });
});

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmDiffCommit: (...args: Parameters<MachineScmDiffCommit>) => machineScmDiffCommitSpy(...args),
}));

vi.mock('@/components/ui/code/diff/DiffFilesListView', () => ({
    DiffFilesListView: (props: any) => React.createElement('DiffFilesListView', props),
}));
vi.mock('@/components/ui/code/WrapLinesToggleButton', () => ({ WrapLinesToggleButton: 'WrapLinesToggleButton' }));

describe('WorkspaceCommitDetailsView', () => {
    beforeEach(() => {
        machineScmDiffCommitSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('keeps workspace server scope when loading a commit diff', async () => {
        const { WorkspaceCommitDetailsView } = await import('./WorkspaceCommitDetailsView');
        const screen = await renderScreen(
            <WorkspaceCommitDetailsView
                scopeId="project:wr_1"
                workspaceRefId="wr_1"
                workspaceCacheKey="wk_1"
                machineId="machine-a"
                rootPath="/repo"
                serverId="server-a"
                sha="abc123"
            />,
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(machineScmDiffCommitSpy).toHaveBeenCalledWith(
            'machine-a',
            {
                cwd: '/repo',
                commit: 'abc123',
            },
            { serverId: 'server-a' },
        );
        expect(screen.findAllByType('WrapLinesToggleButton' as never)).toHaveLength(1);
    });
});

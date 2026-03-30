import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { installSourceControlCommitSelectionCommonModuleMocks } from './sourceControlCommitSelectionTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const applySpy = vi.fn();
vi.mock('@/scm/operations/applyFileStageAction', () => ({
  applyFileStageAction: (...args: any[]) => applySpy(...args),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: any) => void p,
}));

installSourceControlCommitSelectionCommonModuleMocks({
  unistyles: async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
      theme: {
        colors: {
          success: '#0a0',
          textSecondary: '#666',
          divider: '#ddd',
          surface: '#fff',
        },
      },
    });
  },
});

describe('ScmCommitSelectionToggleButton', () => {
  it('toggles commit selection via applyFileStageAction', async () => {
    applySpy.mockResolvedValueOnce(undefined);
    const afterSpy = vi.fn();

    const { ScmCommitSelectionToggleButton } = await import('./ScmCommitSelectionToggleButton');

    const screen = await renderScreen(
        <ScmCommitSelectionToggleButton
            sessionId="s1"
            sessionPath="/tmp/repo"
            snapshot={null}
            scmWriteEnabled={true}
            commitStrategy={'atomic' as any}
            file={{ fullPath: 'src/api.ts' } as any}
            selectedForCommit={false}
            surface="files"
            onAfterToggle={afterSpy}
        />,
    );

    await screen.pressByTestIdAsync(`scm-commit-selection-toggle-${toTestIdSafeValue('src/api.ts')}`);

    expect(applySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        sessionPath: '/tmp/repo',
        filePath: 'src/api.ts',
        stage: true,
        surface: 'files',
      })
    );
    expect(afterSpy).toHaveBeenCalled();
  });
});

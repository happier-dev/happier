import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const applySpy = vi.fn();
vi.mock('@/scm/operations/applyFileStageAction', () => ({
  applyFileStageAction: (...args: any[]) => applySpy(...args),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: any) => void p,
}));

vi.mock('@expo/vector-icons', () => ({
  Octicons: 'Octicons',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Pressable: 'Pressable',
                    ActivityIndicator: 'ActivityIndicator',
                }
    );
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit');
  return await createUnistylesMock({
    theme: {
      colors: {
        success: '#0a0',
        textSecondary: '#666',
        divider: '#ddd',
        surface: '#fff',
      },
    },
  });
});

describe('ScmCommitSelectionToggleButton', () => {
  it('toggles commit selection via applyFileStageAction', async () => {
    applySpy.mockResolvedValueOnce(undefined);
    const afterSpy = vi.fn();

    const { ScmCommitSelectionToggleButton } = await import('./ScmCommitSelectionToggleButton');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ScmCommitSelectionToggleButton
	          sessionId="s1"
	          sessionPath="/tmp/repo"
	          snapshot={null}
	          scmWriteEnabled={true}
	          commitStrategy={'atomic' as any}
	          file={{ fullPath: 'src/api.ts' } as any}
	          selectedForCommit={false}
	          surface="files"
	          onAfterToggle={afterSpy}
	        />)).tree;

    const button = tree.root.findByType('Pressable' as any);
    await act(async () => {
      button.props.onPress({ stopPropagation: vi.fn() });
    });

    await act(async () => {});

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

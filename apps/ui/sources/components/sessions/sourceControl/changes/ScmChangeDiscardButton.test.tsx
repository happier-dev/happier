import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const applySpy = vi.fn();
vi.mock('@/scm/operations/applyFileDiscardAction', () => ({
  applyFileDiscardAction: (...args: any[]) => applySpy(...args),
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
        textSecondary: '#666',
        divider: '#ddd',
        surface: '#fff',
      },
    },
  });
});

describe('ScmChangeDiscardButton', () => {
  it('invokes applyFileDiscardAction when pressed', async () => {
    applySpy.mockResolvedValueOnce(undefined);
    const afterSpy = vi.fn();

    const { ScmChangeDiscardButton } = await import('./ScmChangeDiscardButton');

    let tree!: renderer.ReactTestRenderer;
	    tree = (await renderScreen(<ScmChangeDiscardButton
	          sessionId="s1"
	          sessionPath="/tmp/repo"
	          snapshot={{ capabilities: { writeDiscard: true } } as any}
	          scmWriteEnabled={true}
	          commitStrategy={'git_staging' as any}
	          file={{ fullPath: 'src/api.ts', status: 'modified' } as any}
	          surface="files"
	          onAfterDiscard={afterSpy}
	        />)).tree;

    const button = tree.findByType('Pressable' as any);
    await act(async () => {
      button.props.onPress({ stopPropagation: vi.fn() });
    });

    await act(async () => {});

    expect(applySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        sessionPath: '/tmp/repo',
        surface: 'files',
      })
    );
    expect(afterSpy).toHaveBeenCalled();
  });
});

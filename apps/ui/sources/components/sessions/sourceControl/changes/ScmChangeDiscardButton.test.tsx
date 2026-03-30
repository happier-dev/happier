import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { installSourceControlChangesCommonModuleMocks } from './sourceControlChangesTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const applySpy = vi.fn();
vi.mock('@/scm/operations/applyFileDiscardAction', () => ({
  applyFileDiscardAction: (...args: any[]) => applySpy(...args),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: any) => void p,
}));

installSourceControlChangesCommonModuleMocks();

describe('ScmChangeDiscardButton', () => {
  it('invokes applyFileDiscardAction when pressed', async () => {
    applySpy.mockResolvedValueOnce(undefined);
    const afterSpy = vi.fn();

    const { ScmChangeDiscardButton } = await import('./ScmChangeDiscardButton');

    const screen = await renderScreen(<ScmChangeDiscardButton
        sessionId="s1"
        sessionPath="/tmp/repo"
        snapshot={{ capabilities: { writeDiscard: true } } as any}
        scmWriteEnabled={true}
        commitStrategy={'git_staging' as any}
        file={{ fullPath: 'src/api.ts', status: 'modified' } as any}
        surface="files"
        onAfterDiscard={afterSpy}
    />);

    await screen.pressByTestIdAsync(`scm-discard-${toTestIdSafeValue('src/api.ts')}`);

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

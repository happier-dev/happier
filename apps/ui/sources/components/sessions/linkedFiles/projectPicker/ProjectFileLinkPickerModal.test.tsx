import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installProjectFileLinkPickerCommonModuleMocks } from './projectFileLinkPickerTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

installProjectFileLinkPickerCommonModuleMocks();

vi.mock('@/components/sessions/linkedFiles/projectPicker/LinkFilePickerPopoverContent', () => ({
  LinkFilePickerPopoverContent: (props: any) => React.createElement(
      'LinkFilePickerPopoverContent',
      props,
      React.createElement('Pressable', {
          testID: 'repository-tree-row-src_api.ts',
          onPress: () => {
              props.onPickPath('src/api.ts');
              props.onRequestClose();
          },
      }),
  ),
}));

describe('ProjectFileLinkPickerModal', () => {
  beforeEach(() => {});
  afterEach(() => {});

  it('wires file opens to onPickPath + onClose', async () => {
    const { ProjectFileLinkPickerModal } = await import('./ProjectFileLinkPickerModal');
    const onPickPath = vi.fn();
    const onClose = vi.fn();

    const screen = await renderScreen(
        <ProjectFileLinkPickerModal sessionId="s1" onPickPath={onPickPath} onClose={onClose} />,
    );

    const fileRow = screen.findByTestId('repository-tree-row-src_api.ts');
    await pressTestInstanceAsync(fileRow, 'repository-tree-row-src_api.ts');

    expect(onPickPath).toHaveBeenCalledWith('src/api.ts');
    expect(onClose).toHaveBeenCalled();
  });
});

import * as React from 'react';

import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installMcpServersCommonModuleMocks,
    mcpServersModuleState,
    resetMcpServersCommonModuleMockState,
} from './mcpServersTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pathSelectionListPropsRef: { current: Record<string, unknown> | null } = { current: null };

installMcpServersCommonModuleMocks();

vi.mock('@/components/sessions/new/components/PathSelectionList', () => ({
  PathSelectionList: (props: Record<string, unknown>) => {
    pathSelectionListPropsRef.current = props;
    return React.createElement('PathSelectionList', props);
  },
}));

describe('McpWorkspaceRootPickerModal', () => {
  beforeEach(() => {
    resetMcpServersCommonModuleMockState();
    pathSelectionListPropsRef.current = null;
  });

  it('passes machine browse config to the shared path selection list when machine information is provided', async () => {
    const { McpWorkspaceRootPickerModal } = await import('./McpWorkspaceRootPickerModal');

    await renderScreen(<McpWorkspaceRootPickerModal
          machineId="machine-1"
          machinePlatform="win32"
          machineHomeDir="/Users/test"
          selectedPath="/repo"
          favoriteDirectories={[]}
          onChangeFavoriteDirectories={() => {}}
          onSelectPath={() => {}}
          onClose={() => {}}
        />);

    expect(pathSelectionListPropsRef.current).toMatchObject({
      machineId: 'machine-1',
      serverId: null,
      machineHomeDir: '/Users/test',
      machinePlatform: 'windows',
    });
    expect(mcpServersModuleState.openMachinePathBrowserModalSpy).not.toHaveBeenCalled();
  });

  it('commits a selected workspace root and closes the modal', async () => {
    const onSelectPath = vi.fn();
    const onClose = vi.fn();
    const { McpWorkspaceRootPickerModal } = await import('./McpWorkspaceRootPickerModal');

    await renderScreen(<McpWorkspaceRootPickerModal
          machineId="machine-1"
          serverId="server-1"
          machineHomeDir="/Users/test"
          selectedPath="/repo"
          favoriteDirectories={[]}
          onChangeFavoriteDirectories={() => {}}
          onSelectPath={onSelectPath}
          onClose={onClose}
        />);

    expect(pathSelectionListPropsRef.current).toMatchObject({
      machineId: 'machine-1',
      serverId: 'server-1',
    });
    const onCommit = pathSelectionListPropsRef.current?.onCommit;
    expect(typeof onCommit).toBe('function');

    await act(async () => {
      (onCommit as (path: string) => void)('/repo/selected');
    });

    expect(onSelectPath).toHaveBeenCalledWith('/repo/selected');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

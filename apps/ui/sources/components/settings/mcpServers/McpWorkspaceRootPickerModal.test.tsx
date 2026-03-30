import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installMcpServersCommonModuleMocks,
    mcpServersModuleState,
    resetMcpServersCommonModuleMockState,
} from './mcpServersTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pathSelectorPropsRef: { current: Record<string, unknown> | null } = { current: null };

installMcpServersCommonModuleMocks();

vi.mock('@/components/sessions/new/components/PathSelector', () => ({
  PathSelector: (props: Record<string, unknown>) => {
    pathSelectorPropsRef.current = props;
    return React.createElement('PathSelector', props);
  },
}));

describe('McpWorkspaceRootPickerModal', () => {
  beforeEach(() => {
    resetMcpServersCommonModuleMockState();
    pathSelectorPropsRef.current = null;
  });

  it('passes machine browse config to the shared path selector when machine information is provided', async () => {
    const { McpWorkspaceRootPickerModal } = await import('./McpWorkspaceRootPickerModal');

    await renderScreen(<McpWorkspaceRootPickerModal
          machineId="machine-1"
          machineHomeDir="/Users/test"
          selectedPath="/repo"
          favoriteDirectories={[]}
          onChangeFavoriteDirectories={() => {}}
          onSelectPath={() => {}}
          onClose={() => {}}
        />);

    expect(pathSelectorPropsRef.current).toMatchObject({
      machineBrowse: {
        enabled: true,
        machineId: 'machine-1',
      },
    });
    expect(mcpServersModuleState.openMachinePathBrowserModalSpy).not.toHaveBeenCalled();
  });
});

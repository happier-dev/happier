import { describe, expect, it } from 'vitest';

import { validateSessionHandoffWorkspaceTransferSourcePath } from './validateSessionHandoffWorkspaceTransferSourcePath';

describe('validateSessionHandoffWorkspaceTransferSourcePath', () => {
  it('allows handoff when workspace transfer is disabled', () => {
    expect(
      validateSessionHandoffWorkspaceTransferSourcePath({
        metadata: {
          path: '/Users/tester',
          homeDir: '/Users/tester',
        },
        workspaceTransfer: {
          enabled: false,
          conflictPolicy: 'create_sibling_copy',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      }),
    ).toEqual({ ok: true });
  });

  it('rejects workspace transfer when the source path is the machine home directory', () => {
    expect(
      validateSessionHandoffWorkspaceTransferSourcePath({
        metadata: {
          path: '/Users/tester',
          homeDir: '/Users/tester',
        },
        workspaceTransfer: {
          enabled: true,
          conflictPolicy: 'create_sibling_copy',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      }),
    ).toEqual({
      ok: false,
      errorCode: 'unsafe_workspace_transfer_path',
      error: 'Workspace transfer is unavailable for this source path',
      reasonCode: 'path_is_home_directory',
    });
  });

  it('rejects workspace transfer when metadata is missing homeDir but a fallback home directory matches the source path', () => {
    expect(
      validateSessionHandoffWorkspaceTransferSourcePath({
        metadata: {
          path: '/Users/tester',
        },
        fallbackSourceHomeDir: '/Users/tester',
        workspaceTransfer: {
          enabled: true,
          conflictPolicy: 'create_sibling_copy',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      }),
    ).toEqual({
      ok: false,
      errorCode: 'unsafe_workspace_transfer_path',
      error: 'Workspace transfer is unavailable for this source path',
      reasonCode: 'path_is_home_directory',
    });
  });

  it('rejects workspace transfer when the source path is home-directory shorthand', () => {
    expect(
      validateSessionHandoffWorkspaceTransferSourcePath({
        metadata: {
          path: '~',
        },
        workspaceTransfer: {
          enabled: true,
          conflictPolicy: 'create_sibling_copy',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      }),
    ).toEqual({
      ok: false,
      errorCode: 'unsafe_workspace_transfer_path',
      error: 'Workspace transfer is unavailable for this source path',
      reasonCode: 'path_is_home_directory',
    });
  });

  it('rejects workspace transfer when the source path is not absolute', () => {
    expect(
      validateSessionHandoffWorkspaceTransferSourcePath({
        metadata: {
          path: 'projects/happier',
          homeDir: '/Users/tester',
        },
        workspaceTransfer: {
          enabled: true,
          conflictPolicy: 'create_sibling_copy',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      }),
    ).toEqual({
      ok: false,
      errorCode: 'unsafe_workspace_transfer_path',
      error: 'Workspace transfer is unavailable for this source path',
      reasonCode: 'path_is_not_absolute',
    });
  });
});

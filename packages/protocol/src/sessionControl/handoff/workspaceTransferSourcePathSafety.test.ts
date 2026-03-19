import { describe, expect, it } from 'vitest';

import { evaluateSessionHandoffWorkspaceTransferSourcePathSafety } from './workspaceTransferSourcePathSafety';

describe('evaluateSessionHandoffWorkspaceTransferSourcePathSafety', () => {
  it('rejects missing source paths', () => {
    expect(
      evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: '',
        sourceHomeDir: '/Users/tester',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'missing_source_path',
    });
  });

  it('rejects filesystem roots', () => {
    expect(
      evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: '/',
        sourceHomeDir: '/Users/tester',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_filesystem_root',
    });

    expect(
      evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: 'C:\\',
        sourceHomeDir: 'C:\\Users\\tester',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_filesystem_root',
    });

    expect(
      evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: '/tmp/..',
        sourceHomeDir: '/Users/tester',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_filesystem_root',
    });
  });

  it('rejects source paths that are the machine home directory', () => {
    expect(
      evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: '/Users/tester/',
        sourceHomeDir: '/Users/tester',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_home_directory',
    });

    expect(
      evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: 'C:\\Users\\tester',
        sourceHomeDir: 'c:/Users/tester/',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_home_directory',
    });

    expect(
      evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: '/Users/tester/.',
        sourceHomeDir: '/Users/tester',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_home_directory',
    });
  });

  it('rejects explicit home-directory shorthand paths', () => {
    expect(
      evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: '~',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_home_directory',
    });

    expect(
      evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: '~/',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_home_directory',
    });
  });

  it('allows narrower project paths', () => {
    expect(
      evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: '/Users/tester/projects/happier',
        sourceHomeDir: '/Users/tester',
      }),
    ).toEqual({
      allowed: true,
      reasonCode: null,
    });
  });

  it('rejects relative and drive-relative source paths', () => {
    expect(
      evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: 'projects/happier',
        sourceHomeDir: '/Users/tester',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_not_absolute',
    });

    expect(
      evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: './projects/happier',
        sourceHomeDir: '/Users/tester',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_not_absolute',
    });

    expect(
      evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: 'C:projects\\happier',
        sourceHomeDir: 'C:\\Users\\tester',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_not_absolute',
    });
  });

  it('falls back to a machine home directory when session metadata is missing homeDir', () => {
    expect(
      evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: '/Users/tester',
        fallbackSourceHomeDir: '/Users/tester',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_home_directory',
    });
  });
});

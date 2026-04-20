import { describe, expect, it } from 'vitest';

import {
  FilesystemAccessPolicyConfigurationError,
  resolveFilesystemAccessPolicy,
} from './filesystemAccessPolicy';

describe('resolveFilesystemAccessPolicy', () => {
  it('defaults to OS user access when no restricted root env is configured', () => {
    expect(resolveFilesystemAccessPolicy({ env: {} })).toEqual({ kind: 'osUser' });
  });

  it('parses comma-delimited restricted roots in stable order', () => {
    expect(
      resolveFilesystemAccessPolicy({
        env: {
          HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: '/srv/app, /mnt/work ,, /home/server',
        },
      }),
    ).toEqual({
      kind: 'restrictedRoots',
      roots: ['/srv/app', '/mnt/work', '/home/server'],
    });
  });

  it('expands home-relative restricted roots and dedupes canonical entries', () => {
    expect(
      resolveFilesystemAccessPolicy({
        env: {
          HOME: '/Users/alice',
          HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: '~/workspace,/Users/alice/workspace',
        },
      }),
    ).toEqual({
      kind: 'restrictedRoots',
      roots: ['/Users/alice/workspace'],
    });
  });

  it('dedupes Windows roots case-insensitively when resolving win32 policy', () => {
    expect(
      resolveFilesystemAccessPolicy({
        platform: 'win32',
        env: {
          HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: 'C:\\Users\\Alice\\Work,c:\\users\\alice\\work\\',
        },
      }),
    ).toEqual({
      kind: 'restrictedRoots',
      roots: ['C:\\Users\\Alice\\Work'],
    });
  });

  it('fails closed when any configured root is not absolute', () => {
    expect(() =>
      resolveFilesystemAccessPolicy({
        env: {
          HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: '/srv/app,relative/path',
        },
      }),
    ).toThrow(FilesystemAccessPolicyConfigurationError);
  });
});

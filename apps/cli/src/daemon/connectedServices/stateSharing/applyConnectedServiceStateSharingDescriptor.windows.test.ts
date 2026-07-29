import { rm } from 'node:fs/promises';
import { win32 } from 'node:path';

import type { ConnectedServiceStateSharingDescriptor } from '@/agent/catalog/types';
import { describe, expect, it, vi } from 'vitest';

function createDescriptor(): ConnectedServiceStateSharingDescriptor {
  return {
    providerId: 'pi',
    providerSupportStatus: 'supported',
    config: {
      supported: false,
      modes: ['isolated'],
      entries: [],
    },
    state: {
      supported: true,
      modes: ['shared', 'isolated'],
      entries: [],
      symlinkUnavailableDegradePolicy: 'block_continuity',
    },
    authIsolation: {
      mode: 'materialized_home',
      secretEntries: ['auth.json'],
    },
  };
}

describe('applyConnectedServiceStateSharingDescriptor Windows path invariants', () => {
  it('does not classify a native sibling source as nested under a namespaced target root', async () => {
    vi.resetModules();
    vi.doMock('node:path', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:path')>();
      return {
        ...actual,
        dirname: win32.dirname,
        isAbsolute: win32.isAbsolute,
        join: win32.join,
        relative: win32.relative,
        resolve: win32.resolve,
        sep: win32.sep,
      };
    });

    const { applyConnectedServiceStateSharingDescriptor } = await import('./applyConnectedServiceStateSharingDescriptor');
    const baseRoot = win32.join('C:\\', 'Users', 'test_qa', 'AppData', 'Local', 'Temp', 'happier-windows-pi-postfix-rerun');
    const sourceRoot = win32.join(baseRoot, 'native-pi-agent');
    const targetRoot = win32.toNamespacedPath(win32.join(
      baseRoot,
      'happier-home',
      'daemon',
      'connected-services',
      'materialized',
      '.attempts',
      'csm_pi_attempt',
      'pi-agent-dir',
    ));

    try {
      await expect(applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor(),
        nativeSourceContext: {
          sourceRoot,
          sourceEnv: {},
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {
            PI_CODING_AGENT_DIR: targetRoot,
          },
        },
        configMode: 'isolated',
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        cwd: win32.join(baseRoot, 'workspace'),
      })).resolves.toMatchObject({
        manifest: expect.objectContaining({
          requestedStateMode: 'shared',
          effectiveStateMode: 'shared',
        }),
      });
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
      vi.doUnmock('node:path');
      vi.resetModules();
    }
  });

  it('still rejects a source nested under a namespaced target root after normalization', async () => {
    vi.resetModules();
    vi.doMock('node:path', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:path')>();
      return {
        ...actual,
        dirname: win32.dirname,
        isAbsolute: win32.isAbsolute,
        join: win32.join,
        relative: win32.relative,
        resolve: win32.resolve,
        sep: win32.sep,
      };
    });

    const { applyConnectedServiceStateSharingDescriptor } = await import('./applyConnectedServiceStateSharingDescriptor');
    const targetRoot = win32.toNamespacedPath(win32.join(
      'C:\\',
      'Users',
      'test_qa',
      'AppData',
      'Local',
      'Temp',
      'happier-windows-pi-postfix-rerun',
      'happier-home',
      'daemon',
      'connected-services',
      'materialized',
      '.attempts',
      'csm_pi_attempt',
      'pi-agent-dir',
    ));
    const sourceRoot = win32.join(
      'C:\\',
      'Users',
      'test_qa',
      'AppData',
      'Local',
      'Temp',
      'happier-windows-pi-postfix-rerun',
      'happier-home',
      'daemon',
      'connected-services',
      'materialized',
      '.attempts',
      'csm_pi_attempt',
      'pi-agent-dir',
      'native-source',
    );

    try {
      await expect(applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor(),
        nativeSourceContext: {
          sourceRoot,
          sourceEnv: {},
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {
            PI_CODING_AGENT_DIR: targetRoot,
          },
        },
        configMode: 'isolated',
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        cwd: win32.join('C:\\', 'Users', 'test_qa', 'workspace'),
      })).rejects.toThrow('nativeSourceContext.sourceRoot must not be nested under target.targetMaterializedRoot');
    } finally {
      vi.doUnmock('node:path');
      vi.resetModules();
    }
  });
});

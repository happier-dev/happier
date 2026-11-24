import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { useFileAtRevisionPreview } from './useFileAtRevisionPreview';

const rpc = vi.hoisted(() => ({ machineScmFileRead: vi.fn() }));
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});
// The Machine SCM read RPC is the network boundary; the revision read client and hook stay real.
vi.mock('@/sync/ops/scm/machineScm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/sync/ops/scm/machineScm')>()),
  machineScmFileRead: rpc.machineScmFileRead,
}));

const scope = { serverId: 'srv', machineId: 'm1', rootPath: '/repo' };

describe('useFileAtRevisionPreview', () => {
  it('reads a guest revision using its managed checkout address', async () => {
    rpc.machineScmFileRead.mockClear().mockResolvedValueOnce({ success: false, errorCode: 'unsupported' });
    const workspace = { v: 2, kind: 'managed', serverId: scope.serverId, workspaceId: 'checkout',
      managedId: 'guest', controller: { machineId: scope.machineId, installationId: 'installation' }, rootPath: scope.rootPath } as const;
    const hook = await renderHook(() => useFileAtRevisionPreview({
      enabled: true, scope: { ...scope, workspace }, path: 'logo.png', selector: { side: 'before', area: 'both' },
    }));
    await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'error', errorCode: 'unsupported' }));
    expect(rpc.machineScmFileRead).toHaveBeenCalledExactlyOnceWith(scope.machineId,
      expect.objectContaining({ cwd: scope.rootPath, path: 'logo.png' }), expect.objectContaining({ workspace }));
    rpc.machineScmFileRead.mockReset();
  });

  it('reports an interrupted read as a failed load, not a missing revision, and reads again on retry', async () => {
    const interrupted =
      'The direct machine connection was interrupted. Retry the transfer.';
    const bytes = Buffer.from([1, 2, 3]);
    rpc.machineScmFileRead
      .mockRejectedValueOnce(new Error(interrupted))
      .mockResolvedValueOnce({
        success: true,
        contentBase64: bytes.toString('base64'),
        sizeBytes: 3,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    const hook = await renderHook(
      (attempt: number) =>
        useFileAtRevisionPreview({
          enabled: true,
          scope,
          path: 'logo.png',
          selector: { side: 'before', area: 'both' },
          mimeType: 'image/png',
          attempt,
        }),
      { initialProps: 0 },
    );
    try {
      await vi.waitFor(() =>
        expect(hook.getCurrent()).toMatchObject({
          status: 'error',
          error: interrupted,
          errorCode: null,
        }),
      );
      await hook.rerender(1);
      await vi.waitFor(() =>
        expect(hook.getCurrent()).toMatchObject({
          sizeBytes: 3,
          errorCode: null,
        }),
      );
      expect(rpc.machineScmFileRead).toHaveBeenCalledTimes(2);
    } finally {
      await hook.unmount();
    }
  });
});

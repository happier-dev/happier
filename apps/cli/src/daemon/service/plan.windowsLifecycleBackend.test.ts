import { afterEach, describe, expect, it, vi } from 'vitest';

const { planServiceActionMock } = vi.hoisted(() => ({
  planServiceActionMock: vi.fn(() => ({ writes: [], commands: [] })),
}));

vi.mock('@happier-dev/cli-common/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/service')>();
  return {
    ...actual,
    planServiceAction: planServiceActionMock,
  };
});

import { planDaemonServiceLifecycle } from './plan';

describe('daemon service lifecycle planning windows backend selection', () => {
  afterEach(() => {
    planServiceActionMock.mockClear();
  });

  it('uses the system scheduled-task backend for win32 system mode lifecycle actions', () => {
    planDaemonServiceLifecycle({
      platform: 'win32',
      mode: 'system',
      action: 'restart',
      channel: 'stable',
      instanceId: 'company',
      userHomeDir: 'C:\\Users\\test',
    });

    expect(planServiceActionMock).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'schtasks-system',
      action: 'restart',
    }));
  });
});

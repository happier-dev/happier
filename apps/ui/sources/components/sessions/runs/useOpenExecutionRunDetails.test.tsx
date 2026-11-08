import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const harness = vi.hoisted(() => ({
  push: vi.fn(),
  show: vi.fn((_config: unknown) => 'modal-1'),
  hide: vi.fn(),
  ensureSessionVisibleForMessageRoute: vi.fn(),
}));

vi.mock('@/components/appShell/workspace/destinationRoute', () => ({
  useRouter: () => ({ push: harness.push }),
}));
vi.mock('@/modal', () => ({
  Modal: { show: harness.show, hide: harness.hide },
}));
// The Session read crosses the server boundary; the real hydration owner is covered by its own tests.
vi.mock('@/sync/sync', () => ({
  sync: {
    ensureSessionVisibleForMessageRoute:
      harness.ensureSessionVisibleForMessageRoute,
  },
}));
vi.mock('./details/SessionExecutionRunDetailsView', () => ({
  SessionExecutionRunDetailsView: () => null,
}));

const target = {
  sessionId: 'session-gone',
  serverId: 'server-a',
  machineId: 'machine-1',
  runId: 'run-1',
} as const;

describe('useOpenExecutionRunDetails', () => {
  afterEach(() => {
    standardCleanup();
    vi.clearAllMocks();
  });

  it('opens the Machine run details when the Run Session no longer exists on this Home', async () => {
    harness.ensureSessionVisibleForMessageRoute.mockResolvedValue({
      kind: 'missing',
      sessionId: target.sessionId,
      cause: 'not_found',
    });
    const hook = await renderHook(() => await_open());
    await hook.getCurrent()(target);

    expect(harness.push).not.toHaveBeenCalled();
    expect(harness.show).toHaveBeenCalledTimes(1);
    const props = (
      harness.show.mock.calls[0]![0] as { props: Record<string, unknown> }
    ).props;
    expect(props).toMatchObject({
      sessionId: null,
      serverId: 'server-a',
      workspace: { machineId: 'machine-1' },
      runId: 'run-1',
      sessionRemoved: true,
    });
  });

  it('opens the Session run route when the Session resolves', async () => {
    harness.ensureSessionVisibleForMessageRoute.mockResolvedValue({
      kind: 'available',
      sessionId: target.sessionId,
    });
    const hook = await renderHook(() => await_open());
    await hook.getCurrent()({ ...target, sessionId: 'session-live' });

    expect(harness.show).not.toHaveBeenCalled();
    expect(harness.push).toHaveBeenCalledTimes(1);
    expect(String(harness.push.mock.calls[0]![0])).toContain('session-live');
  });
});

import { useOpenExecutionRunDetails } from './useOpenExecutionRunDetails';
function await_open() {
  return useOpenExecutionRunDetails();
}

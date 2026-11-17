import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

afterEach(standardCleanup);

const { MachineScheduledList } = await import('./MachineScheduledList');
const { t } = await import('@/text');

describe('Machine → Scheduled (lab mSched; MACH-SCHEDULED-READ-1112)', () => {
  it.each(['read', 'observation'] as const)('keeps scheduled jobs visible and qualifies their retained %s failure', async (failure) => {
    const screen = await renderScreen(<MachineScheduledList machineName="machine" onRefresh={() => {}} onMore={() => {}}
      state={{ status: failure === 'read' ? 'error' : 'ready', snapshot: {
        kind: 'snapshot', revision: 3, nextOffset: null, sources: [{ source: 'cron:user', kind: 'available', totalJobs: 1,
          jobs: [{ id: 'daily', name: 'Backup', schedule: 'daily' }],
          ...(failure === 'observation' ? { observation: { kind: 'unavailable' as const, reason: 'watch_native_EACCES' } } : {}),
        }],
      } }} />);
    expect(screen.findByTestId('machine-scheduled.job.daily')).not.toBeNull();
    expect(screen.findByTestId(failure === 'read' ? 'machine-scheduled.stale' : 'machine-scheduled.source.cron:user.observation')).not.toBeNull();
    expect(screen.findByTestId('machine-scheduled.empty')).toBeNull();
  });

  it('draws one section per source with its jobs, an empty source as none, an unreadable source with its reason, and paging', async () => {
    const onMore = vi.fn();
    const screen = await renderScreen(
      <MachineScheduledList
        machineName="hetzner-fsn1"
        onRefresh={() => {}}
        onMore={onMore}
        state={{
          status: 'ready',
          snapshot: {
            kind: 'snapshot',
            revision: 3,
            nextOffset: 4,
            sources: [
              {
                source: 'cron:/etc/crontab',
                kind: 'available',
                totalJobs: 1,
                jobs: [
                  {
                    id: 'cron:/etc/crontab:12',
                    name: 'root',
                    schedule: '17 * * * *',
                  },
                ],
              },
              {
                source: 'cron:user',
                kind: 'available',
                totalJobs: 0,
                jobs: [],
              },
              {
                source: 'systemd:timers',
                kind: 'available',
                totalJobs: 17,
                jobs: [
                  {
                    id: 'systemd:apt-daily.timer',
                    name: 'apt-daily.timer',
                    schedule: 'daily',
                  },
                ],
              },
              {
                source: 'launchd',
                kind: 'unavailable',
                reason: 'not_supported',
              },
            ],
          },
        }}
      />,
    );
    expect(
      screen.findByTestId('machine-scheduled.source.cron:/etc/crontab'),
    ).not.toBeNull();
    expect(
      screen.findByTestId('machine-scheduled.job.cron:/etc/crontab:12'),
    ).not.toBeNull();
    expect(screen.getTextContent()).toContain('17 * * * *');
    // An empty source is a fact, not an error; an unreadable one says so on its own row and the others still show.
    expect(
      screen.findByTestId('machine-scheduled.source.cron:user.none'),
    ).not.toBeNull();
    expect(
      screen.findByTestId('machine-scheduled.source.launchd.unavailable'),
    ).not.toBeNull();
    // A source with more jobs than shown offers the next page.
    await screen.pressByTestIdAsync('machine-scheduled.more');
    expect(onMore).toHaveBeenCalledOnce();
    expect(screen.getTextContent()).toContain(t('machineScheduled.description', { machine: 'hetzner-fsn1' }));
  });

  it('says why nothing could be read and offers to read again', async () => {
    const onRefresh = vi.fn();
    const screen = await renderScreen(
      <MachineScheduledList
        machineName="hetzner-fsn1"
        onRefresh={onRefresh}
        onMore={() => {}}
        state={{
          status: 'error',
          snapshot: null,
          errorCode: 'machine_unreachable',
        }}
      />,
    );
    await screen.pressByTestIdAsync('machine-scheduled.error.retry');
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

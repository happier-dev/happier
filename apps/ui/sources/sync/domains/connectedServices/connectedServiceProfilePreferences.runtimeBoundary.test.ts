import { describe, expect, it, vi } from 'vitest';

describe('connectedServiceProfilePreferences runtime boundary', () => {
  it('keeps UI profile key helpers available when agents package runtime exports are stale', async () => {
    vi.resetModules();
    vi.doMock('@happier-dev/agents', () => ({}));

    const {
      connectedServiceProfileKey,
      resolveConnectedServiceDefaultProfileId,
      resolveConnectedServiceProfileLabel,
    } = await import('./connectedServiceProfilePreferences');

    expect(connectedServiceProfileKey({ serviceId: 'anthropic', profileId: 'work/team' })).toBe(
      'anthropic/work%2Fteam',
    );
    expect(resolveConnectedServiceProfileLabel({
      labelsByKey: { 'anthropic/work%2Fteam': ' Work Team ' },
      serviceId: 'anthropic',
      profileId: 'work/team',
    })).toBe('Work Team');
    expect(resolveConnectedServiceDefaultProfileId({
      serviceId: 'anthropic',
      connectedProfileIds: ['personal', 'work'],
      defaultProfileByServiceId: { anthropic: 'work' },
    })).toBe('work');
  });
});

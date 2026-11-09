import { describe, expect, it } from 'vitest';

import { ServiceHealthNoticePageV1Schema } from '../../activity/accountNoticePageV1.js';
import { PluginDeclarativeButtonV1Schema } from './declarativeButtonsV1.js';
import { PluginWorkItemV1Schema } from './workItems.js';

const hostServicePage = {
  kind: 'host',
  page: 'machine_service',
  machine: { serverId: 'server-1', machineId: 'machine-1' },
    service: { kind: 'deployment', machineId: 'machine-1', environmentId: 'env-1', environmentInstanceId: 'inst-1', composeService: 'web', serviceId: 'inst-1/web' },
};

const workItem = (page: unknown) => ({
  title: 'Ticket',
  category: null,
  linkedSessions: [],
  page,
});

describe('plugin-authored page references', () => {
  it('open the owning plugin page', () => {
    expect(
      PluginDeclarativeButtonV1Schema.safeParse({
        id: 'open',
        label: 'Open',
        effect: { kind: 'open', page: { pageId: 'board', subPath: 'items/1' } },
      }).success,
    ).toBe(true);
    expect(
      PluginWorkItemV1Schema.safeParse(workItem({ pageId: 'board' })).success,
    ).toBe(true);
  });

  it('cannot author host pages, which only host-produced notices route to', () => {
    expect(
      PluginDeclarativeButtonV1Schema.safeParse({
        id: 'open',
        label: 'Open',
        effect: { kind: 'open', page: hostServicePage },
      }).success,
    ).toBe(false);
    expect(
      PluginWorkItemV1Schema.safeParse(workItem(hostServicePage)).success,
    ).toBe(false);
  });
});

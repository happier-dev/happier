import { describe, expect, it } from 'vitest';

import { deploymentReceiptTitle } from '@/components/projects/deployments/deploymentPresentation';
import { resolveUnknownAccountActorName } from '@/sync/domains/account/accountActorPresentation';
import { t } from '@/text';

import {
  activityActorView,
  activityHeadingWithoutActor,
} from './machineFleetActivityRows';

const NO_ACCOUNTS = new Map();

describe('Machines Activity rows without a captured actor (FIDELITY G14)', () => {
  it('names nobody for a record that captured no actor, never "another person"', () => {
    const view = activityActorView(
      null,
      { actorKind: null, displayName: null, onBehalfOf: null },
      null,
      NO_ACCOUNTS,
    );
    expect(view.name).toBeNull();
    expect(view.kind).toBeNull();
    expect(view.name).not.toBe(resolveUnknownAccountActorName('sentence'));
  });

  it('says what happened to which Environment instead ("Deployed 3ed76ad to Production")', () => {
    const heading = activityHeadingWithoutActor({
      kind: 'receipt',
      receipt: { state: 'succeeded', operation: 'deploy' },
      revision: '3ed76ad',
      environmentTitle: 'Production',
    });
    expect(heading).toBe(
      `${deploymentReceiptTitle({ state: 'succeeded', operation: 'deploy' }, '3ed76ad')} ${t('machineFleetActivity.to')} Production`,
    );
    expect(heading).not.toContain(resolveUnknownAccountActorName('sentence'));
  });

  it('says a teardown left its Environment, and an Action by its title alone', () => {
    expect(
      activityHeadingWithoutActor({
        kind: 'receipt',
        receipt: { state: 'succeeded', operation: 'teardown' },
        revision: null,
        environmentTitle: 'Staging',
      }),
    ).toBe(
      `${deploymentReceiptTitle({ state: 'succeeded', operation: 'teardown' }, null)} ${t('machineFleetActivity.from')} Staging`,
    );
    expect(
      activityHeadingWithoutActor({
        kind: 'operation',
        title: 'Instantiate deployment template',
      }),
    ).toBe('Instantiate deployment template');
  });
});

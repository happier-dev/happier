import { describe, expect, it } from 'vitest';
import { applyActionPolicyMutation } from '@happier-dev/protocol/actions/actionAudiencePolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

import { environmentAgentsAskFirst } from './environmentAgentApproval';

const environment = { id: 'env-staging', purpose: 'standard' as const };
const removal = [
  'deployments.teardown',
  'deployments.environments.delete',
] as const;

describe('environmentAgentsAskFirst', () => {
  it('answers yes for a removal under the default policy', () => {
    expect(
      environmentAgentsAskFirst({
        settings: normalizeActionsSettingsV1(undefined),
        environment,
        actionIds: removal,
      }),
    ).toBe(true);
  });

  it('answers no once the person allows agents to remove this Environment without asking', () => {
    let settings = normalizeActionsSettingsV1(undefined);
    for (const actionId of removal) {
      settings = applyActionPolicyMutation(settings, {
        actionId,
        audience: 'agent',
        scope: { kind: 'environment', environmentId: environment.id },
        mode: 'allowed',
      }).settings;
    }
    expect(
      environmentAgentsAskFirst({ settings, environment, actionIds: removal }),
    ).toBe(false);
  });
});

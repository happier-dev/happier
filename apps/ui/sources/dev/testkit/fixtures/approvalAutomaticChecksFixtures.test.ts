import { describe, expect, it } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';

import {
  APPROVAL_CHECKS_PERSON_SCENES,
  APPROVAL_CHECKS_SCENES,
  createApprovalChecksSceneFixture,
} from './approvalAutomaticChecksFixtures';

// The /dev specimen renders each scene through the real card; a scene the server could never publish would mislead it.
describe('approval check scenes', () => {
  it.each(APPROVAL_CHECKS_SCENES)(
    '%s is a request the server publishes',
    (scene) => {
      const { approval } = createApprovalChecksSceneFixture(scene, {
        serverId: 'home',
        accountId: 'account-you',
        nowMs: 1_000_000,
      });
      expect(ApprovalRequestV2Schema.safeParse(approval).error).toBeUndefined();
    },
  );
  it.each(Object.entries(APPROVAL_CHECKS_PERSON_SCENES))('%s (a person’s own deploy) is a request the server publishes', (_scene, checks) => {
    const { approval } = createApprovalChecksSceneFixture(checks, { serverId: 'home', accountId: 'account-you', nowMs: 1_000_000, asker: 'person' });
    expect(ApprovalRequestV2Schema.safeParse(approval).error).toBeUndefined();
  });
});

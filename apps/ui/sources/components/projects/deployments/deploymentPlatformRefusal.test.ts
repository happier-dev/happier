import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { describeDeploymentPlatformRefusal } from './deploymentPlatformRefusal';

// AUTO-LIVE-REVIEW #186 row R4: Use existing on a Vercel project that another Environment already links was refused
// `provider_scope_already_linked`, and Review said "Couldn't create the Vercel project … Vercel didn't create the project".
// Assertions name which copy was chosen (its key), not its wording.
describe('describeDeploymentPlatformRefusal', () => {
  it('names a taken name when the platform refuses the project it was asked to create', () => {
    const copy = describeDeploymentPlatformRefusal({
      platform: 'Vercel',
      resource: 'create',
      code: 'provider_request_failed',
      cause: { httpStatus: 409, errorCode: 'conflict' },
    });
    expect(copy.title).toBe(t('newApp.deploy.plan.platformRefusedTitle', { platform: 'Vercel' }));
    expect(copy.row).toBe(t('newApp.deploy.plan.nameTaken'));
    expect(copy.specific).toBe(true);
  });

  it('names a link refusal for an already-linked project and leaves its reason to the shared recovery owner', () => {
    const copy = describeDeploymentPlatformRefusal({
      platform: 'Vercel',
      resource: 'existing',
      code: 'provider_scope_already_linked',
    });
    expect(copy.title).toBe(t('newApp.deploy.plan.platformLinkRefusedTitle', { platform: 'Vercel' }));
    expect(copy.row).toBe(t('newApp.deploy.plan.alreadyLinked'));
    // deploymentFailureRecoveryV1 owns the sentence for `provider_scope_already_linked` (REVIEW-DELTA6 F3).
    expect(copy.specific).toBe(false);
  });

  it('names any other refused link of an existing project as a link refusal, never a creation', () => {
    const copy = describeDeploymentPlatformRefusal({
      platform: 'Vercel',
      resource: 'existing',
      code: 'provider_request_failed',
    });
    expect(copy.title).toBe(t('newApp.deploy.plan.platformLinkRefusedTitle', { platform: 'Vercel' }));
    expect(copy.row).toBe(t('newApp.deploy.plan.linkRefusedRow'));
    expect(copy.specific).toBe(false);
  });
});

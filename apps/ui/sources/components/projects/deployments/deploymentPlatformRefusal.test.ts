import { describe, expect, it } from 'vitest';
import { describeDeploymentPlatformRefusal } from './deploymentPlatformRefusal';

// AUTO-LIVE-REVIEW #186 row R4: Use existing on a Vercel project that another Environment already links was refused
// `provider_scope_already_linked`, and Review said "Couldn't create the Vercel project … Vercel didn't create the project".
describe('describeDeploymentPlatformRefusal', () => {
  it('names a taken name when the platform refuses the project it was asked to create', () => {
    const copy = describeDeploymentPlatformRefusal({
      platform: 'Vercel',
      resource: 'create',
      code: 'provider_request_failed',
      cause: { httpStatus: 409, errorCode: 'conflict' },
    });
    expect(copy.title).toContain('create');
    expect(copy.row).toBe('Name taken');
  });

  it('says linking, not creating, when an existing project is already linked to another Environment', () => {
    const copy = describeDeploymentPlatformRefusal({
      platform: 'Vercel',
      resource: 'existing',
      code: 'provider_scope_already_linked',
    });
    expect(copy.title).not.toMatch(/create/i);
    expect(copy.description).not.toMatch(/create/i);
    expect(copy.description).toMatch(/already linked/i);
    expect(copy.row).toBe('Already linked');
  });

  it('never claims a creation for any other refused link of an existing project', () => {
    const copy = describeDeploymentPlatformRefusal({
      platform: 'Vercel',
      resource: 'existing',
      code: 'provider_request_failed',
    });
    expect(copy.title).not.toMatch(/create/i);
    expect(copy.description).not.toMatch(/create/i);
    expect(copy.row).not.toMatch(/create/i);
  });
});

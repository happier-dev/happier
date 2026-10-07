import { describe, expect, it } from 'vitest';

import { PUBLIC_ACTION_IDS } from './actionSpecs.js';
import { assertPublicActionSdkMethodNames } from './actionSdkMethodNames.js';

describe('Action SDK method-name validation', () => {
  it('validates only the canonical API-public projection', () => {
    const publicActionIds = new Set<string>(PUBLIC_ACTION_IDS);

    // Internal host plumbing is excluded from the public API projection;
    // decision Actions remain public and still participate in validation.
    expect(() => assertPublicActionSdkMethodNames([
      { id: 'sessions.subagents.upsert', bindings: { sdkMethod: 'execute' } },
    ], publicActionIds)).not.toThrow();

    expect(() => assertPublicActionSdkMethodNames([
      { id: 'teams.directory.sourceSetup.list', bindings: { sdkMethod: 'execute' } },
    ], publicActionIds)).toThrow(/invalid SDK method path/u);

    expect(() => assertPublicActionSdkMethodNames([
      { id: 'sessions.subagents.upsert', bindings: { sdkMethod: 'session.open' } },
      { id: 'teams.directory.sourceSetup.list', bindings: { sdkMethod: 'session.open' } },
    ], publicActionIds)).not.toThrow();

    expect(() => assertPublicActionSdkMethodNames([
      { id: 'session.permission.respond', bindings: { sdkMethod: 'session.open' } },
      { id: 'teams.directory.sourceSetup.list', bindings: { sdkMethod: 'session.open' } },
    ], publicActionIds)).toThrow(/share SDK method path/u);
  });
});

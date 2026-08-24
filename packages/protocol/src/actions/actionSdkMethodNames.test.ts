import { describe, expect, it } from 'vitest';

import { PUBLIC_ACTION_IDS } from './actionSpecs.js';
import { assertPublicActionSdkMethodNames } from './actionSdkMethodNames.js';

describe('Action SDK method-name validation', () => {
  it('validates only the canonical API-public projection', () => {
    const publicActionIds = new Set<string>(PUBLIC_ACTION_IDS);

    expect(() => assertPublicActionSdkMethodNames([
      { id: 'automation.event.admit', bindings: { sdkMethod: 'execute' } },
    ], publicActionIds)).not.toThrow();

    expect(() => assertPublicActionSdkMethodNames([
      { id: 'session.permission.respond', bindings: { sdkMethod: 'execute' } },
    ], publicActionIds)).toThrow(/invalid SDK method path/u);

    expect(() => assertPublicActionSdkMethodNames([
      { id: 'session.permission.respond', bindings: { sdkMethod: 'session.open' } },
      { id: 'automation.event.admit', bindings: { sdkMethod: 'session.open' } },
    ], publicActionIds)).not.toThrow();

    expect(() => assertPublicActionSdkMethodNames([
      { id: 'session.permission.respond', bindings: { sdkMethod: 'session.open' } },
      { id: 'account.apiTokens.list', bindings: { sdkMethod: 'session.open' } },
    ], publicActionIds)).toThrow(/share SDK method path/u);
  });
});

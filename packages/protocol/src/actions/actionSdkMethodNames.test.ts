import { describe, expect, it } from 'vitest';

import { getActionSpec, PUBLIC_ACTION_IDS } from './actionSpecs.js';
import { assertPublicActionSdkMethodNames, resolveActionSdkMethodName } from './actionSdkMethodNames.js';

describe('Action SDK method-name validation', () => {
  it('keeps publish callable alongside its preparation operation', () => {
    const publish = getActionSpec('deployments.publish');
    const prepare = getActionSpec('deployments.publish.prepare');
    expect(resolveActionSdkMethodName(publish)).toBe('deployments.publish');
    expect(resolveActionSdkMethodName(prepare)).toBe('deployments.preparePublish');
    expect(() => assertPublicActionSdkMethodNames([publish, prepare], new Set([publish.id, prepare.id]))).not.toThrow();
  });

  it('validates only the canonical API-public projection', () => {
    const publicActionIds = new Set<string>(PUBLIC_ACTION_IDS);

    // Plugin installation is excluded from API-token ingress. Permission
    // decisions are public for tokens with the explicit Approve grant.
    expect(() => assertPublicActionSdkMethodNames([
      { id: 'plugins.install', bindings: { sdkMethod: 'execute' } },
    ], publicActionIds)).not.toThrow();
    expect(() => assertPublicActionSdkMethodNames([
      { id: 'session.permission.respond', bindings: { sdkMethod: 'execute' } },
    ], publicActionIds)).toThrow(/invalid SDK method path/u);
    expect(() => assertPublicActionSdkMethodNames([
      { id: 'sessions.subagents.upsert', bindings: { sdkMethod: 'execute' } },
    ], publicActionIds)).not.toThrow();

    expect(() => assertPublicActionSdkMethodNames([
      { id: 'teams.directory.sourceSetup.list', bindings: { sdkMethod: 'execute' } },
    ], publicActionIds)).toThrow(/invalid SDK method path/u);

    expect(() => assertPublicActionSdkMethodNames([
      { id: 'plugins.install', bindings: { sdkMethod: 'session.open' } },
      { id: 'sessions.subagents.upsert', bindings: { sdkMethod: 'session.open' } },
      { id: 'teams.directory.sourceSetup.list', bindings: { sdkMethod: 'session.open' } },
    ], publicActionIds)).not.toThrow();

    expect(() => assertPublicActionSdkMethodNames([
      { id: 'session.permission.respond', bindings: { sdkMethod: 'session.open' } },
      { id: 'teams.directory.sourceSetup.list', bindings: { sdkMethod: 'session.open' } },
    ], publicActionIds)).toThrow(/share SDK method path/u);
  });
});

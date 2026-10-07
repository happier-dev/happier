import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';

const expected = [
  ['identity.githubApps.list', 'POST', '/v1/identity/github-apps/list', 'safe'],
  ['identity.githubApps.create', 'POST', '/v1/identity/github-apps/create', 'danger'],
  ['identity.githubApps.manifestSetup.start', 'POST', '/v1/identity/github-apps/manifest-setup/start', 'danger'],
  ['identity.githubApps.update', 'POST', '/v1/identity/github-apps/update', 'danger'],
  ['identity.githubApps.verifyInstallation', 'POST', '/v1/identity/github-apps/verify-installation', 'danger'],
  ['identity.githubApps.remove', 'POST', '/v1/identity/github-apps/remove', 'danger'],
] as const;

describe('managed GitHub App Action contracts', () => {
  it.each(expected)('declares %s through its exact server transport', (id, method, path, safety) => {
    const spec = getActionSpec(ActionIdSchema.parse(id));
    expect(spec.serverTransport).toEqual({ method, path });
    expect(spec.safety).toBe(safety);
    expect(spec.executionPlacement).toBe('account');
  });

  it('requires an exact Home before any managed GitHub App credential lookup', () => {
    for (const [id] of expected) {
      const cli = getActionSpec(ActionIdSchema.parse(id)).cli;
      expect(cli?.acceptsServerId).toBe(true);
      expect(cli?.requiresServerId).toBe(true);
    }
  });

  it('keeps write-only App secrets out of managed GitHub App observations', () => {
    const created = getActionSpec(ActionIdSchema.parse('identity.githubApps.create'))
      .projectObservationInput?.({
        owner: { kind: 'home' },
        githubHost: 'https://github.com',
        githubAppId: '44',
        githubClientId: 'Iv1.client',
        secrets: { privateKey: 'private-key-material', webhookSecret: 'webhook-secret-material' },
      });
    expect(created).toBeDefined();
    expect(JSON.stringify(created)).not.toContain('private-key-material');
    expect(JSON.stringify(created)).not.toContain('webhook-secret-material');
    expect(created).toMatchObject({ owner: { kind: 'home' }, githubClientId: 'Iv1.client' });

    const updated = getActionSpec(ActionIdSchema.parse('identity.githubApps.update'))
      .projectObservationInput?.({
        owner: { kind: 'team', teamId: 'team-1' },
        registrationId: 'registration-1',
        expectedRevision: 2,
        patch: { githubClientId: 'Iv1.rotated', secrets: { privateKey: 'rotated-key-material' } },
      });
    expect(updated).toBeDefined();
    expect(JSON.stringify(updated)).not.toContain('rotated-key-material');
    expect(updated).toMatchObject({
      registrationId: 'registration-1',
      patch: { githubClientId: 'Iv1.rotated' },
    });
  });

  it('admits managed App create requests while retaining strict secret-bearing input', () => {
    const spec = getActionSpec(ActionIdSchema.parse('identity.githubApps.create'));
    expect(spec.surfaces).toMatchObject({ ui: true, cli: true, agent: true, mcp: true, api: false });
    expect(spec.inputSchema.safeParse({
      owner: { kind: 'team', teamId: 'team-1' },
      githubHost: 'https://github.com',
      githubAppId: '44',
      githubClientId: 'Iv1.client',
      secrets: { privateKey: 'private-key' },
    }).success).toBe(true);
    expect(spec.inputSchema.safeParse({
      owner: { kind: 'home' },
      githubHost: 'https://github.com',
      githubAppId: 44,
      githubClientId: 'Iv1.client',
      secrets: { privateKey: 'private-key' },
    }).success).toBe(false);
  });

  it('exposes the redacted managed App read and human-decided mutation requests to agents', () => {
    expect(getActionSpec(ActionIdSchema.parse('identity.githubApps.list')).surfaces)
      .toMatchObject({ ui: true, cli: true, agent: true, mcp: false });
    for (const id of [
      'identity.githubApps.create',
      'identity.githubApps.manifestSetup.start',
      'identity.githubApps.update',
      'identity.githubApps.verifyInstallation',
      'identity.githubApps.remove',
    ] as const) {
      expect(getActionSpec(ActionIdSchema.parse(id)).surfaces)
        .toMatchObject({ agent: true, mcp: true, api: false });
    }
  });

  it('keeps every secret-bearing or browser-mediated managed App operation on an authenticated human caller', () => {
    // Request surfaces do not supply human execution authority for write-only
    // key material or one-time browser handoffs.
    expect(getActionSpec(ActionIdSchema.parse('identity.githubApps.list')).requiredAuthority)
      .toBe('account_automation');
    for (const id of [
      'identity.githubApps.create',
      'identity.githubApps.manifestSetup.start',
      'identity.githubApps.update',
      'identity.githubApps.verifyInstallation',
      'identity.githubApps.remove',
    ] as const) {
      expect(getActionSpec(ActionIdSchema.parse(id)).requiredAuthority, id).toBe('present_user');
    }
  });

  it('redacts one-time GitHub setup and installation handoffs from managed App observations', () => {
    const manifestSetup = getActionSpec(ActionIdSchema.parse('identity.githubApps.manifestSetup.start'))
      .projectObservationOutput?.({
        authorizeUrl: 'https://home.example/v1/identity/github-apps/manifest-setup/submit?handle=one-time-handle',
      });
    expect(manifestSetup).toEqual({ redacted: true });
    expect(JSON.stringify(manifestSetup)).not.toContain('one-time-handle');

    const verifyInstallation = getActionSpec(ActionIdSchema.parse('identity.githubApps.verifyInstallation'))
      .projectObservationOutput?.({
        authorizeUrl: 'https://github.com/login/oauth/authorize?state=one-time-state',
        attemptId: 'attempt-secret',
      });
    expect(verifyInstallation).toEqual({ redacted: true });
    expect(JSON.stringify(verifyInstallation)).not.toContain('one-time-state');
    expect(JSON.stringify(verifyInstallation)).not.toContain('attempt-secret');
  });
});

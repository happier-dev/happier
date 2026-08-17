import { describe, expect, it } from 'vitest';

import { derivePluginDaemonContributionRegistrationRights } from './catalog.js';
import {
  PluginContributesV2Schema,
  PluginDynamicResourceScopeV1Schema,
  PluginResourceContextV1Schema,
  PluginResourceKindV2Schema,
} from './v2.js';

describe('plugin resource contributions', () => {
  it('retains exactly prompt, skill, template, asset, and config resource kinds', () => {
    expect(PluginResourceKindV2Schema.options).toEqual([
      'prompt',
      'skill',
      'template',
      'asset',
      'config',
    ]);

    const parsed = PluginContributesV2Schema.parse({
      resources: PluginResourceKindV2Schema.options.map((kind) => ({
        id: kind,
        kind,
        path: `resources/${kind}.txt`,
        contentType: 'text/plain',
      })),
    });

    expect(parsed.resources.map((resource) => resource.kind)).toEqual(
      PluginResourceKindV2Schema.options,
    );
  });

  it('rejects an undeclared resource kind', () => {
    expect(PluginContributesV2Schema.safeParse({
      resources: [{
        id: 'executable',
        kind: 'executable',
        path: 'resources/tool',
        contentType: 'application/octet-stream',
      }],
    }).success).toBe(false);
  });
});

describe('discriminated resource sourcing (EU-4b §3.6.1)', () => {
  it('admits a dynamic resource declaration that carries no packaged path', () => {
    const parsed = PluginContributesV2Schema.parse({
      resources: [{
        id: 'live-status',
        source: 'dynamic',
        kind: 'config',
        contentType: 'application/json',
      }],
    });

    expect(parsed.resources).toEqual([{
      id: 'live-status',
      source: 'dynamic',
      kind: 'config',
      contentType: 'application/json',
      scope: 'global',
    }]);
  });

  it('admits manifest HostAccess request ids only on the dynamic arm', () => {
    const parsed = PluginContributesV2Schema.parse({
      resources: [{
        id: 'account-status',
        source: 'dynamic',
        kind: 'config',
        contentType: 'application/json',
        hostAccess: ['account-storage'],
      }],
    });

    expect(parsed.resources[0]).toMatchObject({
      id: 'account-status',
      source: 'dynamic',
      hostAccess: ['account-storage'],
    });
    expect(PluginContributesV2Schema.safeParse({
      resources: [{
        id: 'packaged-status',
        kind: 'config',
        path: 'resources/status.json',
        contentType: 'application/json',
        hostAccess: ['account-storage'],
      }],
    }).success).toBe(false);
  });

  it('uses a closed dynamic Resource scope, defaulting legacy declarations to global', () => {
    expect(PluginContributesV2Schema.parse({
      resources: [{
        id: 'session-status',
        source: 'dynamic',
        kind: 'config',
        contentType: 'application/json',
        scope: 'session',
      }],
    }).resources).toEqual([{
      id: 'session-status',
      source: 'dynamic',
      kind: 'config',
      contentType: 'application/json',
      scope: 'session',
    }]);

    expect(PluginContributesV2Schema.safeParse({
      resources: [{
        id: 'wrong-scope',
        source: 'dynamic',
        kind: 'config',
        contentType: 'application/json',
        scope: 'workspace',
      }],
    }).success).toBe(false);
  });

  it('admits a bounded host-stamped surface Resource context without reopening other scopes', () => {
    expect(PluginDynamicResourceScopeV1Schema.options).toEqual([
      'global',
      'session',
      'surface',
    ]);

    expect(PluginContributesV2Schema.parse({
      resources: [{
        id: 'targeted-document',
        source: 'dynamic',
        kind: 'config',
        contentType: 'application/json',
        scope: 'surface',
      }],
    }).resources).toEqual([{
      id: 'targeted-document',
      source: 'dynamic',
      kind: 'config',
      contentType: 'application/json',
      scope: 'surface',
    }]);

    expect(PluginResourceContextV1Schema.parse({
      kind: 'surface',
      mountInstanceKey: 'targeted:acme.target/contributor/preview',
      launchInput: { issue: 42, labels: ['ready'] },
    })).toEqual({
      kind: 'surface',
      mountInstanceKey: 'targeted:acme.target/contributor/preview',
      launchInput: { issue: 42, labels: ['ready'] },
    });

    // Surface-scoped producers always receive the exact host-validated launch
    // input; omitting it would reopen an ambient, unbound surface context.
    expect(PluginResourceContextV1Schema.safeParse({
      kind: 'surface',
      mountInstanceKey: 'targeted:acme.target/contributor/preview',
    }).success).toBe(false);

    // A surface mount cannot smuggle arbitrary context state or bypass the
    // shared launch-input ceiling that normal surface launches already use.
    expect(PluginResourceContextV1Schema.safeParse({
      kind: 'surface',
      mountInstanceKey: 'targeted:acme.target/contributor/preview',
      launchInput: 'x'.repeat(8_193),
    }).success).toBe(false);
    expect(PluginResourceContextV1Schema.safeParse({
      kind: 'surface',
      mountInstanceKey: 'targeted:acme.target/contributor/preview',
      callerContext: { forged: true },
    }).success).toBe(false);
  });

  it('keeps a packaged resource file-bound and refuses a pathless packaged declaration', () => {
    // Negative control against "just make `path` optional": dropping the
    // discrimination entirely would let a packaged resource declare no bytes.
    expect(PluginContributesV2Schema.safeParse({
      resources: [{ id: 'no-path', kind: 'asset', contentType: 'text/plain' }],
    }).success).toBe(false);
    // …and against "just accept anything for dynamic": a dynamic resource has
    // no packaged file, so a path is not part of its shape.
    expect(PluginContributesV2Schema.safeParse({
      resources: [{
        id: 'live-status',
        source: 'dynamic',
        kind: 'config',
        contentType: 'application/json',
        path: 'resources/live.json',
      }],
    }).success).toBe(false);
  });

  it('demands runtime producer registration for the dynamic kind only', () => {
    const contributes = {
      resources: [
        { id: 'packaged-one', kind: 'asset', path: 'resources/a.txt', contentType: 'text/plain' },
        { id: 'live-status', source: 'dynamic', kind: 'config', contentType: 'application/json' },
      ],
    };

    expect(derivePluginDaemonContributionRegistrationRights(contributes)).toEqual([
      { family: 'resources', localId: 'live-status', target: { realm: 'daemon' } },
    ]);
  });
});

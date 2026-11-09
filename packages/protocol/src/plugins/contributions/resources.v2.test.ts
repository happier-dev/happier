import { describe, expect, it } from 'vitest';

import { derivePluginAccountContributionRegistrationRights, derivePluginDaemonContributionRegistrationRights } from './catalog.js';
import { PluginSessionInboxRowPageV1Schema } from './ui/sessionInbox.js';
import {
  PluginContributesV2Schema,
  PluginDynamicResourceScopeV1Schema,
  PluginResourceContextV1Schema,
  PluginResourceKindV2Schema,
} from './v2.js';

describe('plugin resource contributions', () => {
  it('carries the exact closed physical target to contextual Resources without accepting a foreign Session target', () => {
    const repository = { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' };
    const target = { kind: 'project', projectKey: 'logical-project', repository, branch: 'feature/ci' };
    const surface = { kind: 'surface', mountInstanceKey: 'project-page:ci', launchInput: null, target };
    expect(PluginResourceContextV1Schema.parse(surface)).toEqual(surface);
    const session = { kind: 'session', sessionId: 'session-a', target: {
      kind: 'session', sessionId: 'session-a', repository, branch: 'feature/ci', headOid: 'abc123',
    } };
    expect(PluginResourceContextV1Schema.parse(session)).toEqual(session);
    expect(PluginResourceContextV1Schema.safeParse({ ...session, target: { ...session.target, sessionId: 'session-b' } }).success).toBe(false);
    expect(PluginResourceContextV1Schema.safeParse({ ...session, target }).success).toBe(false);
    expect(PluginResourceContextV1Schema.safeParse({ ...surface, target: { ...target, credential: 'never-public' } }).success).toBe(false);
    expect(PluginResourceContextV1Schema.safeParse({ ...surface, target: { ...target, repository: { ...repository, token: 'never-public' } } }).success).toBe(false);
    expect(PluginResourceContextV1Schema.parse({ kind: 'session', sessionId: 'session-a' })).toEqual({ kind: 'session', sessionId: 'session-a' });
  });

  it('keeps the live Inbox page and nested routing/reference envelopes closed', () => {
    const row = { id: 'row', session: { serverId: 'home', sessionId: 'session' }, title: 'Review', detail: null,
      detailResource: { pluginId: 'acme.review', resourceId: 'detail' } };
    expect(PluginSessionInboxRowPageV1Schema.parse({ kind: 'ready', rows: [row], nextCursor: null }))
      .toMatchObject({ rows: [row] });
    for (const invalid of [
      { kind: 'ready', rows: [row], nextCursor: null, run: {} },
      { kind: 'ready', rows: [{ ...row, input: {} }], nextCursor: null },
      { kind: 'ready', rows: [{ ...row, session: { ...row.session, accountId: 'other' } }], nextCursor: null },
      { kind: 'ready', rows: [{ ...row, detailResource: { ...row.detailResource, input: {} } }], nextCursor: null },
      { kind: 'unavailable', reason: 'invented' },
    ]) expect(PluginSessionInboxRowPageV1Schema.safeParse(invalid).success).toBe(false);
    for (const reason of ['locked', 'unavailable', 'denied', 'sourceUnavailable']) {
      expect(PluginSessionInboxRowPageV1Schema.safeParse({ kind: 'unavailable', reason }).success).toBe(true);
    }
  });

  it('binds a paged Session Inbox index to its declared Session detail Resource', () => {
    const index = { id: 'inbox', source: 'dynamic', kind: 'config', contentType: 'application/json',
      scope: 'surface', sessionInbox: { detailResourceId: 'detail' } };
    const detail = { id: 'detail', source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'session' };
    expect(PluginContributesV2Schema.parse({ resources: [index, detail] }).resources[0])
      .toMatchObject({ sessionInbox: { detailResourceId: 'detail' } });
    for (const resources of [[index], [{ ...index, scope: 'global' }, detail],
      [index, { ...detail, scope: 'global' }], [{ ...index, sessionInbox: { detailResourceId: 'detail', input: {} } }, detail]]) {
      expect(PluginContributesV2Schema.safeParse({ resources }).success).toBe(false);
    }
  });

  it('admits shared localized Inbox controls with cross-plugin Actions and exact open destinations', () => {
    const open = { id: 'Review #42 ✨', label: { key: 'review.open', fallback: 'Review' },
      effect: { kind: 'open', page: { pageId: 'deployment-review', subPath: 'deployments/42' } } };
    const action = { id: 'Continue', label: { key: 'review.continue', fallback: 'Continue {count} more · {pullRequest}',
      params: { count: 7, pullRequest: 'example/repository#1' } }, effect: {
      kind: 'action', invocation: { action: { pluginId: 'another.watch', localId: 'watch' },
        input: { kind: 'retryFix', expectedRevision: 4 } },
    } };
    const row = { id: 'row', session: { serverId: 'home', sessionId: 'session' }, title: 'Review', detail: null,
      detailResource: { pluginId: 'acme.review', resourceId: 'detail' }, controls: [open, action] };
    const page = { kind: 'ready', rows: [row], nextCursor: null };
    expect(PluginSessionInboxRowPageV1Schema.parse(page)).toEqual(page);
    for (const controls of [
      [open, { ...open }],
      [{ ...open, callback: 'not-a-declaration' }],
      [{ ...open, label: { ...open.label, locale: 'en' } }],
      [{ ...action, label: { ...action.label, params: { count: { nested: 7 } } } }],
      [{ ...action, label: { ...action.label, params: { count: [7] } } }],
      [{ ...action, label: { ...action.label, params: { count: false } } }],
      [{ ...open, effect: { ...open.effect, input: {} } }],
      [{ ...open, effect: { ...open.effect, page: { ...open.effect.page, pluginId: 'another.page' } } }],
      [{ ...action, effect: { ...action.effect, invocation: { ...action.effect.invocation, args: {} } } }],
      [{ ...action, effect: { ...action.effect, invocation: { ...action.effect.invocation,
        action: { ...action.effect.invocation.action, accountId: 'another' } } } }],
      [{ ...action, effect: { ...action.effect, invocation: { action: action.effect.invocation.action } } }],
    ]) {
      expect(PluginSessionInboxRowPageV1Schema.safeParse({ ...page, rows: [{ ...row, controls }] }).success).toBe(false);
    }
  });

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
  it('admits explicit portable placement independently of Resource scope and grants only its exact activation target', () => {
    const account = { artifactId: 'portable', exportName: 'activate' };
    const contributes = PluginContributesV2Schema.parse({ resources: [
      { id: 'portable-session', source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'session',
        execution: { target: 'account', account } },
      { id: 'daemon-global', source: 'dynamic', kind: 'config', contentType: 'application/json' },
    ] });
    expect(derivePluginAccountContributionRegistrationRights(contributes, account)).toEqual([
      { family: 'resources', localId: 'portable-session', target: { realm: 'account', ...account } },
    ]);
    expect(derivePluginDaemonContributionRegistrationRights(contributes)).toEqual([
      { family: 'resources', localId: 'daemon-global', target: { realm: 'daemon' } },
    ]);
    expect(derivePluginAccountContributionRegistrationRights(contributes, { ...account, artifactId: 'other' })).toEqual([]);
    expect(PluginContributesV2Schema.safeParse({ resources: [{ ...contributes.resources[0],
      execution: { target: 'account', account: { ...account, machineId: 'untrusted' } } }] }).success).toBe(false);
  });
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

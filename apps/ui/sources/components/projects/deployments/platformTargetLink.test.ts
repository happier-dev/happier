import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PluginPortableReleaseManifestV1Schema, type PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';

import {
  buildPlatformTargetDraft,
  buildPlatformTargetLinkInput,
  readDeploymentPlatformTargets,
  readPlatformInspectOutcome,
  disclosePlatformFields,
  applyPlatformFieldPatch,
  drawPlatformFields,
} from './platformTargetLink';

const service = {
  pluginId: 'happier.machine.vercel',
  localId: 'vercel-account',
};
const manifest = {
  id: 'happier.deploy.vercel',
  version: '1.0.0',
  hostAccess: {
    required: [
      {
        id: 'deploy.manage',
        capability: 'connectedAccounts',
        reason: 'Use it.',
        scope: {
          serviceRefs: [service],
          operations: ['use'],
          materializationKinds: ['httpHeaders'],
        },
      },
    ],
    optional: [],
  },
  contributes: {
    actions: [
      {
        id: 'targets-inspect-v1',
        title: 'Inspect',
        hostAccess: ['deploy.manage'],
        connectedAccountPurposeBindings: [
          { path: 'credentialRef', purpose: 'deploy.manage' },
        ],
        inputHints: {
          fields: [
            {
              path: 'providerIdentity.providerAccountId',
              title: 'Vercel account or Team',
              widget: 'select',
              required: true,
            },
          ],
        },
      },
    ],
    deploymentTargets: [
      {
        id: 'runtime',
        role: 'runtime',
        title: 'Vercel',
        targetKind: 'vercel',
        actions: {
          inspect: 'targets-inspect-v1',
          link: 'project-link',
          deploy: 'deploy',
          observe: 'observe',
        },
      },
      {
        id: 'data',
        role: 'data',
        title: 'Not a runtime',
        targetKind: 'vercel-data',
      },
    ],
  },
} as unknown as PluginPortableReleaseManifestV1;
const repository = {
  kind: 'github' as const,
  deployment: 'https://github.com',
  repository: 'acme/site',
};

describe('platform target link model', () => {
  it('derives each runtime platform target from its descriptor, inspect Action and credential purpose', () => {
    const [target, ...rest] = readDeploymentPlatformTargets([{ manifest }]);
    expect(rest).toEqual([]);
    expect(target).toMatchObject({
      pluginId: 'happier.deploy.vercel',
      targetId: 'runtime',
      title: 'Vercel',
      targetKind: 'vercel',
      inspectActionId: 'happier.deploy.vercel/actions/targets-inspect-v1',
      purpose: 'deploy.manage',
      service,
    });
    expect(target?.fields.map((field) => field.path)).toEqual([
      'providerIdentity.providerAccountId',
    ]);
  });

  it('carries the recorded credential and current Environment revision in the partial draft', () => {
    const [target] = readDeploymentPlatformTargets([{ manifest }]);
    const account = { service, accountId: 'e200efeb' };
    const draft = buildPlatformTargetDraft({
      target: target!,
      ownerAccountId: 'owner',
      serverId: 'home',
      environment: { id: 'env-1', revision: 4 },
      account,
      repository,
      values: { providerIdentity: { providerAccountId: 'team-1' } },
    });
    expect(draft).toEqual({
      v: 1,
      serverId: 'home',
      environmentId: 'env-1',
      expectedRevision: 4,
      credentialRef: account,
      credentialPrincipal: {
        kind: 'account',
        accountId: 'owner',
        purpose: {
          consumer: {
            pluginId: 'happier.deploy.vercel',
            localId: 'targets-inspect-v1',
          },
          purpose: 'deploy.manage',
        },
        target: { kind: 'account', account },
      },
      repository,
      providerIdentity: { providerAccountId: 'team-1' },
    });
  });

  it('links the exact inspected provider content to the descriptor target', () => {
    const [target] = readDeploymentPlatformTargets([{ manifest }]);
    const provider = {
      credentialPrincipal: {
        kind: 'account' as const,
        accountId: 'owner',
        purpose: {
          consumer: {
            pluginId: 'happier.deploy.vercel',
            localId: 'targets-inspect-v1',
          },
          purpose: 'deploy.manage',
        },
        target: {
          kind: 'account' as const,
          account: { service, accountId: 'e200efeb' },
        },
      },
      providerIdentity: {
        providerAccountId: 'team-1',
        providerResourceId: 'prj-1',
        providerEnvironment: 'production',
      },
      providerEnvironment: { kind: 'production' as const },
      repositoryAccess: { status: 'ready' as const, repository },
      preparedNative: { projectName: 'site' },
    };
    expect(
      buildPlatformTargetLinkInput({
        target: target!,
        environment: { id: 'env-1', revision: 4 },
        provider,
      }),
    ).toEqual({
      environmentId: 'env-1',
      expectedRevision: 4,
      targetId: 'runtime',
      role: 'runtime',
      targetKind: 'vercel',
      machines: [],
      source: {
        kind: 'plugin',
        contribution: { pluginId: 'happier.deploy.vercel', localId: 'runtime' },
      },
      provider,
    });
  });

  it('reads ready, needs-Git-access and refused Inspect outcomes from the typed result', () => {
    const base = {
      credentialPrincipal: {
        kind: 'account',
        accountId: 'owner',
        purpose: {
          consumer: { pluginId: 'happier.deploy.vercel', localId: 'targets-inspect-v1' },
          purpose: 'deploy.manage',
        },
        target: { kind: 'account', account: { service, accountId: 'e200efeb' } },
      },
      providerIdentity: {
        providerAccountId: 'team-1',
        providerResourceId: 'prj-1',
        providerEnvironment: 'production',
      },
      providerEnvironment: { kind: 'production' },
      preparedNative: { projectName: 'site' },
    };
    expect(
      readPlatformInspectOutcome({
        ok: true,
        value: { ...base, repositoryAccess: { status: 'ready', repository } },
      }).kind,
    ).toBe('ready');
    expect(
      readPlatformInspectOutcome({
        ok: true,
        value: {
          ...base,
          repositoryAccess: {
            status: 'needsGitAccess',
            repository,
            grantUrl: 'https://github.com/apps/vercel/installations/new',
          },
        },
      }),
    ).toMatchObject({
      kind: 'needsGitAccess',
      grantUrl: 'https://github.com/apps/vercel/installations/new',
    });
    expect(
      readPlatformInspectOutcome({
        ok: false,
        code: 'deployment_access_denied',
      }),
    ).toEqual({ kind: 'refused', reason: 'permission', code: 'deployment_access_denied' });
    // Every other refusal keeps its code and reads as one the person fixes by their choices, then checks again.
    expect(
      readPlatformInspectOutcome({ ok: false, code: 'server_scope_mismatch' }),
    ).toEqual({ kind: 'refused', reason: 'other', code: 'server_scope_mismatch' });
    expect(
      readPlatformInspectOutcome({
        ok: true,
        value: { providerIdentity: 'not content' },
      }),
    ).toEqual({ kind: 'refused', reason: 'other', code: 'provider_response_invalid' });
  });
});

describe('deployment platforms from bundled declarations', () => {
  const bundled = (name: string) => ({
    manifest: PluginPortableReleaseManifestV1Schema.parse(JSON.parse(readFileSync(
      resolve('../../apps/cli/assets/bundled-plugin-manifests', `${name}.json`), 'utf8'))),
  });
  // Parsed per case: a manifest that stops parsing fails these cases, not the whole file.
  const readTargets = () => readDeploymentPlatformTargets([bundled('deploy-vercel'), bundled('deploy-cloudflare')]);

  it('offers each runtime contribution with its own identity', () => {
    const targets = readTargets();
    expect(targets.map((target) => target.key)).toEqual([
      'happier.deploy.vercel/runtime',
      'happier.deploy.cloudflare/workers',
      'happier.deploy.cloudflare/pages',
    ]);
    expect(targets.every((target) => target.title.length > 0)).toBe(true);
  });

  it('keeps Cloudflare product as provider input for the independently selected target', () => {
    const pages = readTargets().find(target => target.key === 'happier.deploy.cloudflare/pages')!;
    const account = { service: pages.service, accountId: 'cloudflare-account' };
    const draft = buildPlatformTargetDraft({ target: pages, account, ownerAccountId: 'owner', serverId: 'home',
      environment: { id: 'environment', revision: 1 }, repository: null, values: { product: 'workers' } });
    expect(draft.product).toBe('workers');
    expect(buildPlatformTargetLinkInput({ target: pages, environment: { id: 'environment', revision: 1 },
      provider: { credentialPrincipal: { kind: 'account', accountId: 'owner',
        purpose: { consumer: { pluginId: pages.pluginId, localId: pages.inspectLocalId }, purpose: pages.purpose },
        target: { kind: 'account', account } },
        providerIdentity: { providerAccountId: 'account', providerResourceId: 'site', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' } } })).toMatchObject({
      targetId: 'pages', targetKind: 'cloudflare-pages', source: { contribution: { localId: 'pages' } },
    });
  });
});

describe('platform choice disclosure', () => {
  const field = (path: string, required = true) => ({ path, required, widget: 'select', title: path }) as never;
  const fields = [field('account'), field('note', false), field('project'), field('environment')];

  it('draws each choice once the required choice above it is made', () => {
    const paths = (values: Record<string, unknown>) => disclosePlatformFields(fields, values).map((entry: { path: string }) => entry.path);
    expect(paths({})).toEqual(['account']);
    // An optional choice never holds back the required one after it.
    expect(paths({ account: 'team-1' })).toEqual(['account', 'note', 'project']);
    expect(paths({ account: 'team-1', project: 'prj-1' })).toEqual(['account', 'note', 'project', 'environment']);
  });

  it('keeps a first choice and clears the choices read for an old answer', () => {
    const first = applyPlatformFieldPatch(fields, {}, { account: 'team-1' });
    expect(first).toEqual({ values: { account: 'team-1' }, changedIndex: 0 });
    const full = { account: 'team-1', note: 'n', project: 'prj-1', environment: 'production' };
    expect(applyPlatformFieldPatch(fields, full, { account: 'team-2' })).toEqual({
      values: { account: 'team-2' },
      changedIndex: 0,
    });
    expect(applyPlatformFieldPatch(fields, full, { project: 'prj-2' })).toEqual({
      values: { account: 'team-1', note: 'n', project: 'prj-2' },
      changedIndex: 2,
    });
    expect(applyPlatformFieldPatch(fields, full, { project: 'prj-1' })).toEqual({ values: full, changedIndex: -1 });
  });

  it('says one failed read once, at the sheet, and draws no choice after it', () => {
    const states: Record<string, { status: 'loading' | 'ready' | 'failed'; options: readonly unknown[]; errorCode?: string }> = {
      account: { status: 'ready', options: [{ value: 'team-1' }] },
      note: { status: 'failed', options: [], errorCode: 'provider_response_invalid' },
      project: { status: 'failed', options: [], errorCode: 'provider_response_invalid' },
    };
    const drawn = drawPlatformFields(fields, { account: 'team-1' }, (entry: { path: string }) => states[entry.path]!, () => false);
    expect(drawn.fields.map((entry: { path: string }) => entry.path)).toEqual(['account']);
    expect(drawn.failure).toEqual({ code: 'provider_response_invalid' });
    // A Check after a failed read can only repeat the same cause.
    expect(drawn.canCheck).toBe(false);
  });

  it('offers Check only once a choice is made, even when every choice is optional', () => {
    const optional = [field('product', false), field('project', false)];
    const ready = () => ({ status: 'ready' as const, options: [{ value: 'x' }] });
    expect(drawPlatformFields(optional, {}, ready, () => false).canCheck).toBe(false);
    expect(drawPlatformFields(optional, { project: 'site' }, ready, () => false).canCheck).toBe(true);
  });

  it('leaves out an optional choice this target has nothing for (a Worker has no Pages project)', () => {
    const states: Record<string, { status: 'ready'; options: readonly unknown[] }> = {
      account: { status: 'ready', options: [{ value: 'team-1' }] }, note: { status: 'ready', options: [] },
      project: { status: 'ready', options: [{ value: 'prj-1' }] }, environment: { status: 'ready', options: [] },
    };
    const drawn = drawPlatformFields(fields, { account: 'team-1', project: 'prj-1' }, (entry: { path: string }) => states[entry.path]!, () => false);
    expect(drawn.fields.map((entry: { path: string }) => entry.path)).toEqual(['account', 'project', 'environment']);
    expect(drawn.failure).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PluginPortableReleaseManifestV1Schema, type PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import { resolveEffectiveActionInputFields, type EffectiveActionInputField } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { listDeploymentTargetsFromManifestsV1, projectDeploymentSuggestionTargetsV1 } from '@happier-dev/deployments';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { DeploySuggestionCatalogV1Schema } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';

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
        accepts: ['static'],
        needs: ['repository'],
        icon: 'server-outline',
        targetSchema: { type: 'object', properties: {}, additionalProperties: false },
        linkSchema: { type: 'object', properties: {}, additionalProperties: false },
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
        icon: 'server-outline',
        targetSchema: { type: 'object', properties: {}, additionalProperties: false },
        linkSchema: { type: 'object', properties: {}, additionalProperties: false },
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
  it('offers the same runtime target identities as the registered suggestions catalog Action', async () => {
    const declarations = [{ manifest }];
    const read = await createActionExecutor({
      // Registry, Account and Machine inventory reads terminate at their transport ports.
      registryActionExecute: async () => ({ pages: [] }),
      machinesList: async () => ({ items: [] }),
      connectedServiceAction: async () => ({ accounts: [], pools: [], healthBasis: 'credentials', source: { completeness: 'complete', observedAtMs: 1 } }),
      deploymentSuggestionTargets: async () => projectDeploymentSuggestionTargetsV1(listDeploymentTargetsFromManifestsV1(declarations)),
    }).execute('deployments.suggestions.catalog', {}, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home' });
    expect(read, JSON.stringify(read)).toMatchObject({ ok: true });
    if (!read.ok) throw new Error(read.errorCode);
    const catalog = DeploySuggestionCatalogV1Schema.parse(read.result);
    expect(catalog.targets.filter(target => target.targetClass === 'platform').map(target => ({
      id: target.id, title: target.title, accepts: target.accepts, needs: target.needs,
    }))).toEqual(readDeploymentPlatformTargets(declarations).map(target => ({
      id: target.key, title: target.title, accepts: target.accepts, needs: target.needs,
    })));
  });
  it('offers teardown only when the runtime target declares it', () => {
    const runtime = manifest.contributes.deploymentTargets![0]!;
    if (runtime.role !== 'runtime') throw new Error('Expected the runtime target descriptor');
    const withTeardown = { ...manifest, contributes: { ...manifest.contributes,
      deploymentTargets: [{ ...runtime, actions: { ...runtime.actions, teardown: 'teardown' } }],
    } } as PluginPortableReleaseManifestV1;
    expect(readDeploymentPlatformTargets([{ manifest: withTeardown }])[0]).toHaveProperty('teardown', true);
    expect(readDeploymentPlatformTargets([{ manifest }])[0]).not.toHaveProperty('teardown');
  });
  it('offers runtime logs only when the runtime target declares that canonical role', () => {
    const runtime = manifest.contributes.deploymentTargets![0]!;
    if (runtime.role !== 'runtime') throw new Error('Expected the runtime target descriptor');
    const withLogs = { ...manifest, contributes: { ...manifest.contributes,
      deploymentTargets: [{ ...runtime, actions: { ...runtime.actions, logs: { runtime: 'runtime-logs-read' } } }],
    } } as PluginPortableReleaseManifestV1;
    expect(readDeploymentPlatformTargets([{ manifest: withLogs }])[0]).toHaveProperty('runtimeLogs', true);
    expect(readDeploymentPlatformTargets([{ manifest }])[0]).not.toHaveProperty('runtimeLogs');
  });
  it('offers creation fields and credential purpose only from an implemented create Action', () => {
    const runtime = manifest.contributes.deploymentTargets![0]!;
    if (runtime.role !== 'runtime') throw new Error('Expected the runtime target descriptor');
    const create = { ...manifest.contributes.actions![0]!, id: 'create-project',
      hostAccess: ['create.manage'], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'create.manage' }],
      inputHints: { fields: [{ path: 'resourceName', title: 'Project name', widget: 'text' as const, required: true }] } };
    const withCreation = { ...manifest,
      hostAccess: { ...manifest.hostAccess, required: [...manifest.hostAccess!.required,
        { ...manifest.hostAccess!.required[0]!, id: 'create.manage' }] },
      contributes: { ...manifest.contributes, actions: [...manifest.contributes.actions!, create],
        deploymentTargets: [{ ...runtime, actions: { ...runtime.actions, create: 'create-project' } }] },
    } as PluginPortableReleaseManifestV1;
    expect(readDeploymentPlatformTargets([{ manifest: withCreation }])[0]).toMatchObject({ create: {
      localId: 'create-project', actionId: 'happier.deploy.vercel/actions/create-project', purpose: 'create.manage', service,
      fields: [{ path: 'resourceName', required: true }],
    } });
    expect(readDeploymentPlatformTargets([{ manifest }])[0]).not.toHaveProperty('create');
    const missingAction = { ...withCreation, contributes: { ...withCreation.contributes, actions: manifest.contributes.actions } };
    expect(readDeploymentPlatformTargets([{ manifest: missingAction }])[0]).not.toHaveProperty('create');
  });
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
    expect(buildPlatformTargetLinkInput({ target: target!, environment: { id: 'env-1', revision: 4 }, provider, role: 'data' }))
      .toMatchObject({ role: 'data', provider });
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

  it('keeps an empty Account read visible with its reason for every bundled platform after Retry', () => {
    for (const target of readTargets()) {
      const fields = disclosePlatformFields(resolveEffectiveActionInputFields({ inputHints: { fields: [...target.fields] } }, {}), {});
      expect(fields.map(field => field.path), target.key).toEqual([target.fields[0]?.path]);
      expect(fields[0]?.required, target.key).toBe(true);
      expect(drawPlatformFields(fields, {}, () => ({ status: 'ready', options: [] }), () => false), target.key)
        .toMatchObject({ failure: { code: 'provider_options_empty' }, canCheck: false });
    }
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
  const field = (path: string, required = true): EffectiveActionInputField => ({ path, required, visible: true, disabled: false, widget: 'select', title: path });
  const fields = [field('account'), field('note', false), field('project'), field('environment')];

  it('says why a required choice is empty after Retry, while keeping paging and optional empty choices usable', () => {
    const account = [field('account')];
    const draw = (status: 'loading' | 'ready' | 'failed', options: readonly unknown[], paged = false) =>
      drawPlatformFields(account, {}, () => ({ status, options, errorCode: 'plugin_action_generation_retired' }), () => paged);
    expect(draw('failed', []).failure).toEqual({ code: 'plugin_action_generation_retired' });
    expect(draw('loading', []).failure).toBeNull();
    expect(draw('ready', [])).toMatchObject({ failure: { code: 'provider_options_empty' }, canCheck: false });
    expect(draw('ready', [], true).failure).toBeNull();
    expect(draw('ready', [{ value: 'account' }]).failure).toBeNull();
    expect(drawPlatformFields(account, {}, () => ({ status: 'ready', options: [], nextCursor: 'next' }), () => false).failure).toBeNull();
    expect(drawPlatformFields(account, { account: 'selected' }, () => ({ status: 'ready', options: [] }), () => false).failure).toBeNull();
    expect(drawPlatformFields([{ ...field('name'), widget: 'text' }], {}, () => ({ status: 'ready', options: [] }), () => false).failure).toBeNull();
    expect(drawPlatformFields([{ ...field('custom'), allowCustomValue: true }], {}, () => ({ status: 'ready', options: [] }), () => false).failure).toBeNull();
    expect(drawPlatformFields([field('optional', false)], {}, () => ({ status: 'ready', options: [] }), () => false).failure).toBeNull();
  });

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

  it('seeds declared defaults for reset downstream fields while keeping the edited value authoritative', () => {
    const createFields: EffectiveActionInputField[] = [field('account'), field('project'),
      { ...field('sourceMethod'), defaultValue: 'upload' },
      { ...field('providerEnvironment'), widget: 'json', defaultValue: { kind: 'production' } }];
    const original = { account: 'team-1', project: 'old', sourceMethod: 'upload',
      providerEnvironment: { kind: 'preview' } };
    expect(applyPlatformFieldPatch(createFields, original, { account: 'team-2' }).values).toEqual({
      account: 'team-2', sourceMethod: 'upload', providerEnvironment: { kind: 'production' },
    });
    expect(applyPlatformFieldPatch(createFields, original, { sourceMethod: undefined }).values).toEqual({
      account: 'team-1', project: 'old', providerEnvironment: { kind: 'production' },
    });
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
      project: { status: 'ready', options: [{ value: 'prj-1' }] }, environment: { status: 'ready', options: [{ value: 'production' }] },
    };
    const drawn = drawPlatformFields(fields, { account: 'team-1', project: 'prj-1' }, (entry: { path: string }) => states[entry.path]!, () => false);
    expect(drawn.fields.map((entry: { path: string }) => entry.path)).toEqual(['account', 'project', 'environment']);
    expect(drawn.failure).toBeNull();
  });
});

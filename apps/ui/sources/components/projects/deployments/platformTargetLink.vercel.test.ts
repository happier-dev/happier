import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../../../../../../packages/plugins/deploy-vercel/src/index';
import { activateAccount } from '../../../../../../packages/plugins/deploy-vercel/src/account';
import { patchHappierActionInputPath } from '@happier-dev/plugin-ui/presentation';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { applyPlatformFieldPatch, buildPlatformTargetDraft, readDeploymentPlatformTargets, readPlatformInspectOutcome }
  from './platformTargetLink';

it.each(['daemon-root', 'portable-account'] as const)('admits the r17 sheet choices without a caller-normalized identity through %s', async target => {
  const project = { id: 'prj_Uyy9CT3gK5T1FkB9QCZZu5ZXoxUj',
    accountId: 'team_IfWoDydKwqFwMDLSXA80FDAW', name: 'happier-qa-deploy' };
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(project)) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest,
    module: target === 'daemon-root' ? entry : { ...entry, activateAccount }, services: { http } });
  try {
    // The UI consumes this same plugin declaration through its portable projection.
    const [platform] = readDeploymentPlatformTargets([{ manifest: entry.manifest as unknown as PluginPortableReleaseManifestV1 }]);
    if (!platform) throw new Error('Missing Vercel platform');
    const choices = [project.accountId, project.id, { kind: 'production' }];
    let values: Record<string, unknown> = {};
    platform.fields.forEach((field, index) => {
      values = applyPlatformFieldPatch(platform.fields, values,
        patchHappierActionInputPath(values, field.path, choices[index])).values;
    });
    const draft = buildPlatformTargetDraft({ target: platform, ownerAccountId: 'owner', serverId: 'home',
      environment: { id: 'environment', revision: 1 },
      account: { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'selected-pat' },
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'happier-dev/triage-qa-sandbox' }, values });
    // r17's form supplies account, project and native environment; Inspect owns the comparison tuple.
    const result = await kit.invokeAction('targets-inspect-v1', draft as JsonValue);
    expect(result).toMatchObject({ providerIdentity: { providerAccountId: project.accountId,
      providerResourceId: project.id, providerEnvironment: 'production' }, repositoryAccess: { status: 'needsGitAccess' } });
    expect(readPlatformInspectOutcome({ ok: true, value: result })).toMatchObject({ kind: 'needsGitAccess' });
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([`/v9/projects/${project.id}`]);
  } finally { await kit.dispose(); }
});


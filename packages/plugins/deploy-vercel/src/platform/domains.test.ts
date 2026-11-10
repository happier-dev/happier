import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';
import { activateAccount } from '../account.js';

const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'fixture' };
const input = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  targetLinkId: 'link', expectedTargetLinkRevision: 1, credentialRef: account,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
    consumer: { pluginId: entry.manifest.id, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
  providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_exact', providerEnvironment: 'preview:main' },
  providerEnvironment: { kind: 'preview', gitBranch: 'main' }, domainId: 'domain', domain: { hostname: 'app.example.test' } };

it('adds the exact preview Domain, reads pending DNS without mutating, and removes only that Domain', async () => {
  const requests: HttpRequest[] = [];
  let removed = false;
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (removed) throw new Error('DELETE already acknowledged removal');
    if (request.method === 'DELETE') {
      removed = true;
      return { status: 200, headers: {}, body: new TextEncoder().encode('"removed"') };
    }
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
      name: 'app.example.test', projectId: 'prj_exact', gitBranch: 'main', verified: false,
      verification: [{ type: 'TXT', domain: '_vercel.app.example.test', value: 'verification-token' }] })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    expect(entry.manifest.contributes.deploymentTargets[0]).toMatchObject({ actions: { domains: {
      add: 'domains-add', read: 'domains-read', verify: 'domains-verify', remove: 'domains-remove' } } });
    for (const action of ['domains-add', 'domains-verify']) {
      await expect(kit.invokeAction(action, input)).resolves.toMatchObject({ v: 1, hostname: 'app.example.test', state: 'pending',
        dns: [{ type: 'TXT', name: '_vercel.app.example.test', value: 'verification-token' }] });
    }
    await expect(kit.invokeAction('domains-remove', input)).resolves.toMatchObject({ state: 'removed' });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['POST', '/v10/projects/prj_exact/domains'], ['GET', '/v9/projects/prj_exact/domains/app.example.test'],
      ['GET', '/v9/projects/prj_exact/domains/app.example.test'],
      ['DELETE', '/v9/projects/prj_exact/domains/app.example.test'],
    ]);
    expect(requests.every(request => new URL(request.url).searchParams.get('teamId') === 'team_exact')).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(requests[0]!.body))).toEqual({ name: 'app.example.test', gitBranch: 'main' });
  } finally { await kit.dispose(); }
});

it('retains an ambiguous remote mutation without retrying or reporting absence', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) { requests.push(request); throw new Error('transport lost'); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction('domains-add', input)).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(requests.map(request => request.method)).toEqual(['POST']);
  } finally { await kit.dispose(); }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as entry from '@happier-dev/plugins-machine-maritime';

// Public author-command entry. Only vendor HTTP and host credential material
// are replaced; fixtures follow Maritime OpenAPI 0.1.0 (2026-11-05).
test('the public configurator offers both persistent Linux kinds', async () => {
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer constructed-test-token' } }) },
    http: { request: async ({ url }) => ({ status: 200, finalUrl: url, headers: {},
      body: new TextEncoder().encode(JSON.stringify({ plan: 'growth', minMemMb: 512, maxMemMb: 8192, maxDiskGb: 100 })) }) },
  } });
  try {
    const options = await kit.invokeAction('options', {}, { surface: 'plugin' });
    assert.deepEqual(options.dimensions.image.map(option => option.id), ['agent-box', 'linux-computer']);
    for (const [kind, size, alwaysOn] of [['agent-box', 'box-2048', true], ['linux-computer', 'computer-4096', false]]) {
      const selected = projectMachineProvisionerSelectionV1({ options,
        selection: { image: kind, size, location: 'account' }, launchSchema: entry.MACHINE_PROVISIONER.launchSchema });
      assert.equal(selected.kind, 'ready');
      assert.equal(selected.launch.kind, kind);
      assert.equal(selected.launch.alwaysOn, alwaysOn);
      assert.equal(selected.guestPlatform, 'linux');
      assert.ok(selected.retention.supportedIntents.includes('resume'));
    }
  } finally { await kit.dispose(); }
});

for (const kind of ['agent-box', 'linux-computer']) {
  test(`${kind}: lost create reconciles exactly, sleeping work wakes, deletion confirms absence`, async () => {
    const isBox = kind === 'agent-box';
    const root = isBox ? '/api/agents' : '/api/v1/computers';
    const managedId = 'public-author-managed';
    const launch = { kind, memMb: isBox ? 2048 : 4096, diskGb: 5, alwaysOn: isBox, templateId: 'zeroclaw' };
    let created = false;
    let present = true;
    let sleeping = true;
    let posts = 0;
    const effects = [];
    const native = () => isBox
      ? { id: 'box-one', name: managedId, externalId: managedId, framework: 'zeroclaw', tier: 'always_on',
          status: sleeping ? 'sleeping' : 'active', invocationCount: 0, createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' }
      : { id: 'computer-one', externalUserId: managedId, os: 'linux', arch: 'x86_64', status: sleeping ? 'sleeping' : 'ready',
          screen: { width: 1280, height: 800, modelWidth: 1200, modelHeight: 750 }, mode: 'agent', createdAt: '2026-11-05T00:00:00Z' };
    const request = async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === root && req.method === 'POST') {
        posts++;
        const body = await req.json();
        assert.equal(body[isBox ? 'externalId' : 'externalUserId'], managedId);
        created = true;
        throw new TypeError('constructed lost response');
      }
      if (url.pathname === root) {
        assert.equal(url.searchParams.get(isBox ? 'externalId' : 'externalUserId'), managedId);
        const entries = created ? [native()] : [];
        return Response.json(isBox ? entries : { computers: entries });
      }
      if (req.method === 'DELETE') { present = false; return new Response(null, { status: 204 }); }
      if (url.pathname.endsWith(isBox ? '/start' : '/wake')) {
        effects.push('resume'); sleeping = false; return Response.json(native());
      }
      if (url.pathname.endsWith('/sleep')) { sleeping = true; return Response.json(native()); }
      if (url.pathname.endsWith('/exec')) {
        effects.push('exec');
        const body = await req.json();
        if (isBox) assert.equal(body.detached, true);
        const output = { exitCode: 0, stdout: 'done', stderr: '' };
        return Response.json(isBox ? { ...output, executionId: 'exec-one', status: 'completed' } : output);
      }
      return present ? Response.json(native()) : new Response(null, { status: 404 });
    };
    const client = entry.createMaritimeNativeClient(request, new AbortController().signal, 1000);
    assert.equal((await client.acquire(launch, managedId)).kind, 'pending');
    const recovered = await client.recover({ kind: 'acquire', launch, managedId });
    assert.equal(recovered.kind, 'bound');
    assert.equal(posts, 1);
    const resource = recovered.resource.value;
    assert.equal((await client.inspect(resource)).power, 'suspended');
    await client.exec({ resource, argv: ['true'] });
    assert.deepEqual(effects, ['resume', 'exec']);
    assert.equal((await client.power(resource, 'suspend')).kind, 'confirmed');
    assert.equal((await client.power(resource, 'resume')).kind, 'confirmed');
    assert.equal((await client.destroy({ resource })).kind, 'confirmed');
    assert.equal((await client.inspect(resource)).availability, 'absent');
  });
}

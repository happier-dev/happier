import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedDependencyStatus } from '@happier-dev/plugin-sdk/managed-services';
import type { PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { DOCKER_SANDBOXES_PLUGIN } from './manifest.js';
import { MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { DockerSandboxesLaunchV1Schema, DOCKER_SANDBOXES_ROLE_SCHEMAS } from './machine/schemas.js';

const resource = { sandboxName: 'happier-managed-row-1' };
const inventory = JSON.stringify({ sandboxes: [{ name: resource.sandboxName, status: 'running' }] });
const exited = (stdout: Uint8Array, stderr = new Uint8Array()): PluginProcessResult => ({
  termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
  stdout, stderr, stdoutTruncated: false, stderrTruncated: false,
});

function fixture(run: ExecService['run'], version = '0.46.0') {
  const status = vi.fn(async (): Promise<ManagedDependencyStatus> => ({ state: 'ready', id: 'docker-sandboxes-cli', version, sourceId: 'system',
    executable: { kind: 'managedDependency', id: { pluginId: DOCKER_SANDBOXES_PLUGIN.manifest.id, localId: 'docker-sandboxes-cli' } },
  }));
  // Only the external host process/dependency service boundary is supplied.
  // The canonical testkit keeps declaration, activation and role schemas real.
  const services = { exec: { run }, managedServices: { dependencies: { status } } } as unknown as PluginTestServicesFixture;
  return { status, services };
}

describe('activated Docker Sandboxes public role boundary', () => {
  it('preserves authored failure details from Check through the public action', async () => {
    const refusal = new PluginError({ code: 'host_access_denied', message: 'Allow the native process', details: { phase: 'admission' } });
    const boundary = fixture(async () => { throw refusal; });
    const kit = await createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest, module: DOCKER_SANDBOXES_PLUGIN, services: boundary.services });
    try { await expect(kit.invokeAction('check', {}, { surface: 'plugin' })).rejects.toMatchObject({
      name: 'PluginError', code: refusal.code, message: refusal.message, details: refusal.details,
    }); }
    finally { await kit.dispose(); }
  });
  it('reports the declared missing native prerequisite without inventing an installer or probing a missing executable', async () => {
    const run = vi.fn<ExecService['run']>();
    const boundary = fixture(run);
    boundary.status.mockResolvedValue({ state: 'missing', id: 'docker-sandboxes-cli', supported: true });
    const kit = await createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest, module: DOCKER_SANDBOXES_PLUGIN, services: boundary.services });
    try {
      expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({ available: false,
        prerequisites: [{ requirement: { kind: 'managedDependency', id: { pluginId: DOCKER_SANDBOXES_PLUGIN.manifest.id,
          localId: 'docker-sandboxes-cli' } }, status: 'unavailable', repairAction: {
            action: { pluginId: DOCKER_SANDBOXES_PLUGIN.manifest.id, localId: 'install-runtime' }, input: {},
          } }] });
      expect(run).not.toHaveBeenCalled();
      // A failed dependency read is unknown, not evidence that the tool is missing.
      boundary.status.mockRejectedValueOnce(new Error('dependency status did not answer'));
      const unknown = await kit.invokeAction('check', {}, { surface: 'plugin' });
      expect(unknown).toMatchObject({ available: false });
      expect(unknown).not.toHaveProperty('prerequisites');
    } finally { await kit.dispose(); }
  });

  it('offers native sign-in repair when sbx is installed but signed out without attempting login', async () => {
    const run = vi.fn<ExecService['run']>(async request => request.args?.[0] === 'template'
      ? { ...exited(new Uint8Array(), new TextEncoder().encode('not signed in to Docker')),
        termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } } }
      : exited(new Uint8Array()));
    const boundary = fixture(run);
    const kit = await createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest, module: DOCKER_SANDBOXES_PLUGIN, services: boundary.services });
    try {
      expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({ available: false, code: 'credential_unavailable',
        prerequisites: [{ repairAction: { action: { pluginId: DOCKER_SANDBOXES_PLUGIN.manifest.id, localId: 'sign-in' } } }] });
      expect(run.mock.calls.some(([request]) => request.args?.[0] === 'login')).toBe(false);
    } finally { await kit.dispose(); }
  });

  it('materializes Docker PAT only into login stdin and refuses failed login without disclosing output', async () => {
    const token = 'qa-private-pat';
    const run = vi.fn<ExecService['run']>(async request => request.args?.[0] === 'login'
      ? { ...exited(new TextEncoder().encode(token), new TextEncoder().encode(token)),
        termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } } }
      : exited(new Uint8Array()));
    const boundary = fixture(run);
    const account = { service: { pluginId: DOCKER_SANDBOXES_PLUGIN.manifest.id, localId: 'docker' }, accountId: 'qa' };
    const services = { ...boundary.services, connectedAccounts: {
      getBinding: async () => ({ account }), materialize: async () => ({ kind: 'environment', env: { DOCKER_ID: 'qa-user', DOCKER_PAT: token } }),
    } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest, module: DOCKER_SANDBOXES_PLUGIN, services });
    try {
      const failure = await kit.invokeAction('sign-in', {}, { surface: 'plugin' }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'credential_unavailable', details: { phase: 'native_login', termination: { observed: { kind: 'exit', exitCode: 1 } } } });
      expect(String(failure)).not.toContain(token);
      expect(JSON.stringify(failure)).not.toContain(token);
      const request = run.mock.calls.find(([request]) => request.args?.[0] === 'login')?.[0];
      expect(request?.args).toEqual(['login', '--username', 'qa-user', '--password-stdin']);
      expect(new TextDecoder().decode(request?.stdin)).toBe(token + '\n');
      expect(JSON.stringify(request?.args)).not.toContain(token);
      run.mockImplementation(async () => exited(new Uint8Array()));
      expect(await kit.invokeAction('sign-in', {}, { surface: 'plugin' })).toBeNull();
    } finally { await kit.dispose(); }
  });

  it('qualifies every native template offered by options through the registered acquire role', async () => {
    const templates = ['docker.io/example/first:1', 'docker.io/example/second:2'];
    const run = vi.fn<ExecService['run']>(async request => exited(new TextEncoder().encode(
      request.args?.[0] === 'template' ? templates.join('\n') : request.args?.[0] === 'ls' ? inventory : '')));
    const boundary = fixture(run);
    const kit = await createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest, module: DOCKER_SANDBOXES_PLUGIN, services: boundary.services });
    try {
      const options = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', {}, { surface: 'plugin' }));
      expect(options.dimensions.image).toHaveLength(2);
      for (const selected of options.dimensions.image) {
        const projected = projectMachineProvisionerSelectionV1({ options, selection: { image: selected.id }, launchSchema: DockerSandboxesLaunchV1Schema.jsonSchema });
        expect(projected.kind).toBe('ready');
        if (projected.kind !== 'ready') throw new Error('Native template did not project an executable launch');
        const input = DOCKER_SANDBOXES_ROLE_SCHEMAS.acquireInput.parse({ launch: projected.launch, managedId: 'managed-row-1' });
        expect(await kit.invokeAction('acquire', input, { surface: 'plugin' }))
          .toMatchObject({ kind: 'bound', resource: { value: resource } });
      }
      expect(run.mock.calls.filter(([request]) => request.args?.[0] === 'create').map(([request]) => request.args?.[4])).toEqual(templates);
    } finally { await kit.dispose(); }
  });

  it('stays effect-free on activation and operates a compatible newer native CLI', async () => {
    const run = vi.fn<ExecService['run']>(async request => exited(new TextEncoder().encode(
      request.args?.[0] === 'template' ? 'docker.io/example/template:1\n' : request.args?.[0] === 'ls' ? inventory : '')));
    const boundary = fixture(run, '0.47.0');
    const kit = await createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest, module: DOCKER_SANDBOXES_PLUGIN, services: boundary.services });
    try {
      expect(boundary.status).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({ available: true });
      expect(await kit.invokeAction('acquire', { launch: { name: 'happier', templateId: 'docker.io/example/template:1' }, managedId: 'managed-row-1' }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'bound', resource: { value: resource } });
    } finally { await kit.dispose(); }
  });

  it('validates strict retained inputs and carries exact binary process facts across the registered exec role', async () => {
    const binary: PluginProcessResult = { ...exited(new Uint8Array([255, 0]), new Uint8Array([128])),
      stdoutTruncated: true, termination: { observed: { kind: 'signal', signal: 'SIGTERM' }, requestedBy: { kind: 'abort' } } };
    const run = vi.fn<ExecService['run']>(async request => request.args?.[0] === 'ls'
      ? exited(new TextEncoder().encode(inventory)) : binary);
    const boundary = fixture(run);
    const kit = await createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest, module: DOCKER_SANDBOXES_PLUGIN, services: boundary.services });
    try {
      await expect(kit.invokeAction('exec', { resource: { ...resource, sandboxId: 'unqualified-cloud-id' }, argv: ['cat'] }, { surface: 'plugin' })).rejects.toBeDefined();
      expect(run).not.toHaveBeenCalled();
      expect(await kit.invokeAction('exec', { resource, argv: ['cat'], inputBase64: 'AP4K' }, { surface: 'plugin' })).toEqual({
        termination: binary.termination, stdoutBase64: '/wA=', stderrBase64: 'gA==', stdoutTruncated: true, stderrTruncated: false,
      });
      const request = run.mock.calls.find(([request]) => request.args?.[0] === 'exec')?.[0];
      expect(request?.stdin).toEqual(Buffer.from('AP4K', 'base64'));
      expect(request?.args).toEqual(['exec', '--interactive', '--', resource.sandboxName, 'cat']);
    } finally { await kit.dispose(); }
  });

  it('decodes the shared role byte grammar without imposing a stricter leaf encoding policy', async () => {
    const run = vi.fn<ExecService['run']>(async request => exited(request.args?.[0] === 'ls'
      ? new TextEncoder().encode(inventory) : new Uint8Array()));
    const boundary = fixture(run);
    const kit = await createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest, module: DOCKER_SANDBOXES_PLUGIN, services: boundary.services });
    try {
      // The shared role schema accepts this encoding of byte zero. Native IO
      // consumes decoded bytes; another textual encoding rule is not its owner.
      expect(await kit.invokeAction('put-file', { resource, guestPath: '/tmp/private-payload', bytesBase64: 'AB==' }, { surface: 'plugin' }))
        .toEqual({ kind: 'confirmed' });
      const delivered = run.mock.calls.find(([request]) => request.args?.[0] === 'exec')?.[0].stdin;
      expect(delivered && Array.from(delivered)).toEqual([0]);
    } finally { await kit.dispose(); }
  });
  it('builds, inspects and destroys an owned prepared template through the shared qualified roles', async () => {
    const operationId = 'public-build';
    const launch = { templateId: 'docker.io/sbx/shell:latest', name: 'my-sandbox' };
    const builder = `happier-prepared-${operationId}`;
    const templateId = `happier-prepared:${operationId}`;
    const templates = new Set(['someone-else:keep']);
    const builders = new Set<string>();
    const run = vi.fn<ExecService['run']>(async request => {
      const args = request.args ?? [];
      if (args[0] === 'template' && args[1] === 'ls') return exited(new TextEncoder().encode([...templates].join('\n')));
      if (args[0] === 'ls') return exited(new TextEncoder().encode(JSON.stringify({ sandboxes: [...builders].map(name => ({ name, status: 'stopped' })) })));
      if (args[0] === 'create') builders.add(builder);
      if (args[0] === 'template' && args[1] === 'save') templates.add(templateId);
      if (args[0] === 'template' && args[1] === 'rm') templates.delete(args.at(-1)!);
      if (args[0] === 'rm') builders.delete(args.at(-1)!);
      return exited(new Uint8Array());
    });
    const boundary = fixture(run);
    const kit = await createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest, module: DOCKER_SANDBOXES_PLUGIN, services: boundary.services });
    const contributionRef = { pluginId: DOCKER_SANDBOXES_PLUGIN.manifest.id, localId: 'docker-sandboxes' };
    const nativeOperation = { contributionRef, schemaVersion: 1, value: { operationId, launch } };
    try {
      const built = await kit.invokeAction('prepare-build', { operationId,
        input: { launch: { provider: contributionRef, schemaVersion: 1, choices: launch },
          cli: { identity: 'public-cli', versionId: '0.3.0', binaryPath: '/opt/happier/happier', installScript: 'true', files: [] },
          setupScript: 'printf prepared > /opt/prepared\n' } }, { surface: 'plugin' });
      expect(built).toEqual({ kind: 'ready', artifact: { contributionRef, schemaVersion: 1, value: { templateId, launch: { ...launch, templateId } } } });
      expect(await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' })).toEqual(built);
      expect(await kit.invokeAction('prepare-inspect', { nativeOperation }, { surface: 'plugin' })).toEqual(built);
      expect(await kit.invokeAction('prepare-destroy', { artifact: { contributionRef, schemaVersion: 1, value: { templateId, launch: { ...launch, templateId } } }, nativeOperation }, { surface: 'plugin' }))
        .toEqual({ kind: 'confirmed' });
      expect(templates).toEqual(new Set(['someone-else:keep']));
      expect(builders.size).toBe(0);
      await expect(kit.invokeAction('prepare-destroy', { artifact: { contributionRef, schemaVersion: 1,
        value: { templateId: 'someone-else:keep', launch } } }, { surface: 'plugin' })).rejects.toBeDefined();
      expect(templates).toEqual(new Set(['someone-else:keep']));
    } finally { await kit.dispose(); }
  });

});

describe('brand mark', () => {
  it('declares its packaged brand mark through the generic brand Resource', () => {
    expect(DOCKER_SANDBOXES_PLUGIN.manifest.brand).toEqual({ iconResourceId: 'brand-icon' });
    expect(DOCKER_SANDBOXES_PLUGIN.manifest.contributes.resources?.filter(({ id }) => id === 'brand-icon')).toEqual([{ id: 'brand-icon', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }]);
    const asset = readFileSync(new URL('../assets/brand.png', import.meta.url));
    expect([...asset.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(asset.readUInt32BE(16)).toBe(asset.readUInt32BE(20));
  });

});

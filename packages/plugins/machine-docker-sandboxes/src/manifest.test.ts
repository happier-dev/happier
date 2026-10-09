import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { DOCKER_SANDBOXES_PLUGIN } from './manifest.js';

const resource = { sandboxName: 'happier-managed-row-1' };
const exited = (stdout: Uint8Array, stderr = new Uint8Array()): PluginProcessResult => ({
  termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
  stdout, stderr, stdoutTruncated: false, stderrTruncated: false,
});

function fixture(run: ExecService['run'], version = '0.46.0') {
  const status = vi.fn(async () => ({ state: 'ready', id: 'docker-sandboxes-cli', version, sourceId: 'system',
    executable: { kind: 'managedDependency', id: { pluginId: DOCKER_SANDBOXES_PLUGIN.manifest.id, localId: 'docker-sandboxes-cli' } },
  }));
  // Only the external host process/dependency service boundary is supplied.
  // The canonical testkit keeps declaration, activation and role schemas real.
  const services = { exec: { run }, managedServices: { dependencies: { status } } } as unknown as PluginTestServicesFixture;
  return { status, services };
}

describe('activated Docker Sandboxes public role boundary', () => {
  it('stays effect-free on activation and refuses an unqualified native version before allocation', async () => {
    const run = vi.fn<ExecService['run']>(async () => exited(new Uint8Array()));
    const boundary = fixture(run, '0.41.0');
    const kit = await createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest, module: DOCKER_SANDBOXES_PLUGIN, services: boundary.services });
    try {
      expect(boundary.status).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({ available: false, code: 'docker_sandbox_version_unqualified',
        status: { key: 'machineDocker.presentation.docker_sandbox_version_unqualified' } });
      expect(await kit.invokeAction('acquire', { launch: { name: 'happier', templateId: 'docker.io/example/template:1' }, managedId: 'managed-row-1' }, { surface: 'plugin' }))
        .toEqual({ kind: 'rejected', code: 'provider_unavailable' });
      expect(run).not.toHaveBeenCalled();
    } finally { await kit.dispose(); }
  });

  it('validates strict retained inputs and carries exact binary process facts across the registered exec role', async () => {
    const binary: PluginProcessResult = { ...exited(new Uint8Array([255, 0]), new Uint8Array([128])),
      stdoutTruncated: true, termination: { observed: { kind: 'signal', signal: 'SIGTERM' }, requestedBy: { kind: 'abort' } } };
    const run = vi.fn<ExecService['run']>(async request => request.args?.[0] === 'ls'
      ? exited(new TextEncoder().encode(`${resource.sandboxName}\n`)) : binary);
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
      ? new TextEncoder().encode(`${resource.sandboxName}\n`) : new Uint8Array()));
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
});

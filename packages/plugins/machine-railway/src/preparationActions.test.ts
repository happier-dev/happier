import { readFileSync } from 'node:fs';
import { PluginError } from '@happier-dev/plugin-sdk';
import { MachineProvisionerPreparationBuildResultV1Schema, MachineProvisionerPreparationInspectResultV1Schema, MachineProvisionerPreparationDestroyResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { railwayVendor } from '../testkit/vendor.js';
import * as entry from './index.js';
import { RECONCILIATION } from './machine/schemas.js';

const contributionRef = { pluginId: 'happier.machine.railway', localId: 'railway' };
const launch = { environmentId: 'environment-one' };
const input = { operationId: 'build-one', input: { launch: { provider: contributionRef, schemaVersion: 1, choices: launch },
  cli: { identity: 'public-release:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier',
    installScript: 'cp payload "$HOME/installed-cli"; exit 0', files: [{ path: 'payload', contentsBase64: 'Q0xJ' }] },
  setupScript: 'test "$(cat "$HOME/installed-cli")" = CLI; printf setup > "$HOME/setup-finished"',
} };
function services(request: typeof fetch, waitForNativeObservation: () => Promise<void>): PluginTestServicesFixture {
  // Substitute only credential custody and Railway's GraphQL/files transport.
  return {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-key' } }) },
    machineProvisioners: { waitForNativeObservation },
    http: { request: async (call: { url: string; method: string; headers?: Record<string, string>; body?: Uint8Array }) => {
      const response = await request(call.url, { method: call.method, headers: call.headers,
        body: call.body === undefined ? undefined : new TextDecoder().decode(call.body) });
      return { status: response.status, finalUrl: call.url, headers: {}, body: new Uint8Array(await response.arrayBuffer()) };
    } },
  } as unknown as PluginTestServicesFixture;
}
async function kitFor(request: typeof fetch, waitForNativeObservation = async () => { throw new Error('Unexpected native wait'); }) {
  return createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(request, waitForNativeObservation) });
}

describe('Railway preparation through public Actions', () => {
  it('builds a clean guest, installs credential-free files, runs setup, checkpoints, launches and verifies both deletions', async () => {
    const vendor = railwayVendor(), kit = await kitFor(vendor.request);
    try {
      const result = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', input, { surface: 'plugin' }));
      expect(result.kind).toBe('ready');
      if (result.kind !== 'ready') throw new Error('Preparation did not finish');
      expect(readFileSync(vendor.home + '/installed-cli', 'utf8')).toBe('CLI');
      expect(readFileSync(vendor.home + '/setup-finished', 'utf8')).toBe('setup');
      expect(vendor.present).toBe(false);
      const artifact = result.artifact;
      expect(artifact.value).toMatchObject({ environmentId: launch.environmentId, checkpointId: 'checkpoint-one',
        launch: { environmentId: launch.environmentId, checkpoint: expect.stringContaining('happier-prepared-') } });
      const inspected = MachineProvisionerPreparationInspectResultV1Schema.parse(await kit.invokeAction('prepare-inspect', { operationId: input.operationId, launch }, { surface: 'plugin' }));
      expect(inspected).toEqual(result);
      const acquired = RECONCILIATION.result.parse(await kit.invokeAction('acquire', { managedId: 'session-one', launch: artifact.value.launch }, { surface: 'plugin' }));
      expect(acquired).toMatchObject({ kind: 'bound' });
      const creates = vendor.calls.filter(call => call.query.includes('sandboxCreate('));
      expect(creates).toHaveLength(2);
      expect(creates[0]?.variables).toEqual({ input: { environmentId: launch.environmentId, idleTimeoutMinutes: 0 } });
      expect(creates[1]?.variables).toMatchObject({ input: { template: { name: artifact.value.launch.checkpoint } } });
      expect(MachineProvisionerPreparationDestroyResultV1Schema.parse(await kit.invokeAction('prepare-destroy', { artifact }, { surface: 'plugin' }))).toEqual({ kind: 'confirmed' });
      expect(vendor.calls.find(call => call.query.includes('sandboxCheckpointDelete('))?.variables).toEqual({ environmentId: launch.environmentId, id: 'checkpoint-one' });
      expect(vendor.foreignPresent).toBe(true);
      // Session guest teardown remains the ordinary resource lifecycle.
      if (acquired.kind === 'bound') await kit.invokeAction('destroy', { resource: acquired.resource.value }, { surface: 'plugin' });
    } finally { await kit.dispose(); vendor.cleanup(); }
  });

  it('does not report an absent checkpoint as proof that an uncorrelatable lost guest create was cleaned', async () => {
    const vendor = railwayVendor(); vendor.loseCreate();
    const kit = await kitFor(vendor.request);
    try {
      const result = await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(result).toMatchObject({ kind: 'unknown', code: 'railway_preparation_create_unconfirmed', nativeOperationRef: { value: { operationId: input.operationId } } });
      expect(await kit.invokeAction('prepare-inspect', { operationId: input.operationId, launch }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'unknown', code: 'railway_preparation_create_unconfirmed' });
      expect(vendor.calls.filter(call => call.query.includes('sandboxCreate('))).toHaveLength(1);
    } finally { await kit.dispose(); vendor.cleanup(); }
  });

  it('retains the allocated build guest after a native 403 instead of dropping its only cleanup identity', async () => {
    const vendor = railwayVendor();
    const request: typeof fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      return body.query.includes('sandboxExec(') ? new Response(null, { status: 403 }) : vendor.request(url, init);
    };
    const kit = await kitFor(request);
    try {
      const result = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', input, { surface: 'plugin' }));
      expect(result).toMatchObject({ kind: 'unknown', code: 'credential_unavailable', nativeOperationRef: { value: { sandboxId: 'sandbox-one' } } });
      if (result.kind !== 'unknown') throw new Error('Missing paid resource identity');
      const cleanupKit = await kitFor(vendor.request);
      try { expect(await cleanupKit.invokeAction('prepare-destroy', { nativeOperation: result.nativeOperationRef }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' }); }
      finally { await cleanupKit.dispose(); }
      expect(vendor.present).toBe(false);
      expect(vendor.calls.filter(call => call.query.includes('sandboxCreate('))).toHaveLength(1);
    } finally { await kit.dispose(); vendor.cleanup(); }
  });

  it('retains a validated paid guest identity even when create reports FAILED instead of running', async () => {
    const vendor = railwayVendor(); vendor.setStatus('FAILED');
    const kit = await kitFor(vendor.request);
    try {
      const result = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', input, { surface: 'plugin' }));
      expect(result).toMatchObject({ kind: 'unknown', code: 'railway_sandbox_failed', nativeOperationRef: { value: { sandboxId: 'sandbox-one' } } });
      if (result.kind !== 'unknown') throw new Error('Missing validated guest identity');
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: result.nativeOperationRef }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(vendor.present).toBe(false);
    } finally { await kit.dispose(); vendor.cleanup(); }
  });

  it('recovers a lost checkpoint response by operation identity and deletes only its owned guest and checkpoint', async () => {
    const vendor = railwayVendor(); vendor.loseCheckpoint();
    const kit = await kitFor(vendor.request);
    try {
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' })).toMatchObject({ kind: 'unknown' });
      const recovered = MachineProvisionerPreparationInspectResultV1Schema.parse(await kit.invokeAction('prepare-inspect', { operationId: input.operationId, launch }, { surface: 'plugin' }));
      expect(recovered).toMatchObject({ kind: 'failed', code: 'railway_preparation_guest_cleanup_required', nativeOperationRef: { value: { sandboxId: 'sandbox-one', checkpointId: 'checkpoint-one' } } });
      if (recovered.kind !== 'failed') throw new Error('Missing cleanup reference');
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: recovered.nativeOperationRef }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(vendor.present).toBe(false);
      expect([...vendor.checkpoints.keys()]).toEqual(['shared-recipe-hash']);
      expect(vendor.calls.filter(call => call.query.includes('sandboxCreate('))).toHaveLength(1);
    } finally { await kit.dispose(); vendor.cleanup(); }
  });

  it('does not claim deletion while Railway still lists the checkpoint', async () => {
    const vendor = railwayVendor(), kit = await kitFor(vendor.request);
    try {
      const built = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', input, { surface: 'plugin' }));
      if (built.kind !== 'ready') throw new Error('Missing ready artifact');
      vendor.deferCheckpointDelete(true);
      expect(await kit.invokeAction('prepare-destroy', { artifact: built.artifact }, { surface: 'plugin' })).toMatchObject({ kind: 'pending' });
      vendor.deferCheckpointDelete(false);
      expect(await kit.invokeAction('prepare-destroy', { artifact: built.artifact }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
    } finally { await kit.dispose(); vendor.cleanup(); }
  });

  it('waits on the host cadence for native readiness and build guest deletion before returning ready', async () => {
    const vendor = railwayVendor(); vendor.setStatus('CREATING'); vendor.deferGuestDelete(true);
    let waits = 0;
    const kit = await kitFor(vendor.request, async () => {
      waits++;
      if (waits === 1) vendor.setStatus('RUNNING'); else vendor.disappearGuest();
    });
    try {
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' })).toMatchObject({ kind: 'ready' });
      expect(vendor.present).toBe(false);
      expect(waits).toBe(2);
      expect(vendor.calls.filter(call => call.query.includes('sandboxCreate('))).toHaveLength(1);
      expect(vendor.calls.filter(call => call.query.includes('sandboxDestroy('))).toHaveLength(1);
    } finally { await kit.dispose(); vendor.cleanup(); }
  });

  it('retains the requested checkpoint key when the capture response returns another identity', async () => {
    const vendor = railwayVendor(); vendor.checkpointMismatch(true);
    const kit = await kitFor(vendor.request);
    try {
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' })).toMatchObject({ kind: 'unknown',
        code: 'railway_checkpoint_identity_mismatch', nativeOperationRef: { value: { sandboxId: 'sandbox-one', checkpointKey: expect.stringContaining('happier-prepared-') } } });
      expect(vendor.calls.some(call => call.query.includes('sandboxCheckpointDelete('))).toBe(false);
    } finally { await kit.dispose(); vendor.cleanup(); }
  });

  it('refuses a mismatched checkpoint deletion id without deleting another cache entry', async () => {
    const vendor = railwayVendor(), kit = await kitFor(vendor.request);
    try {
      const built = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', input, { surface: 'plugin' }));
      if (built.kind !== 'ready') throw new Error('Missing ready artifact');
      const foreign = { ...built.artifact, value: { ...built.artifact.value, checkpointId: 'foreign-checkpoint' } };
      expect(await kit.invokeAction('prepare-destroy', { artifact: foreign }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'refused', code: 'railway_checkpoint_identity_mismatch' });
      expect(vendor.calls.some(call => call.query.includes('sandboxCheckpointDelete('))).toBe(false);
    } finally { await kit.dispose(); vendor.cleanup(); }
  });

  it('keeps the build guest cleanup reference when cancellation interrupts file transfer', async () => {
    const vendor = railwayVendor(), controller = new AbortController();
    vendor.abortFiles(() => controller.abort());
    const kit = await kitFor(vendor.request);
    try {
      const result = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', input, { surface: 'plugin', signal: controller.signal }));
      expect(result).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { sandboxId: 'sandbox-one' } } });
      if (result.kind !== 'unknown') throw new Error('Missing interrupted operation');
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: result.nativeOperationRef }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(vendor.present).toBe(false);
    } finally { await kit.dispose(); vendor.cleanup(); }
  });

  it.each(['prepare-build', 'prepare-inspect', 'prepare-destroy'])('preserves typed host refusals through %s', async action => {
    const error = new PluginError({ code: 'plugin_fetch_interceptor_failed' });
    const kit = await kitFor(async () => { throw error; });
    const nativeOperation = { contributionRef, schemaVersion: 1, value: { operationId: input.operationId, environmentId: launch.environmentId } };
    try {
      await expect(kit.invokeAction(action, action === 'prepare-build' ? input : { nativeOperation }, { surface: 'plugin' })).rejects.toMatchObject({ data: error.data });
    } finally { await kit.dispose(); }
  });
});

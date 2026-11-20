import { buildMachineProvisionerPreparationInstallScript } from '@happier-dev/plugin-sdk/machine-provisioners';
import { Buffer } from 'node:buffer';
import { CloudError, cloudCode, object, invalidResponse, type createCloudClient } from './nativeClient.js';
import { reference, type PreparationInput, type PreparationOperation } from './schemas.js';

type Client = ReturnType<typeof createCloudClient>;
const body = (response: { body: Uint8Array }): unknown => {
  try { return JSON.parse(new TextDecoder().decode(response.body)); } catch { return invalidResponse(); }
};
function snapshot(value: unknown) {
  const item = object(value);
  if (typeof item.name !== 'string' || !/^snapshots\/[^/]+$/.test(item.name)
    || item.uid !== item.name.slice('snapshots/'.length) || typeof item.status !== 'string' || typeof item.etag !== 'string') return invalidResponse();
  return { name: item.name, status: item.status, etag: item.etag, displayName: item.displayName, sandbox: item.sandbox };
}
const displayName = (id: string) => 'happier-prepared-' + encodeURIComponent(id);
const pending = (operation: PreparationOperation) => ({ kind: 'pending' as const, nativeOperationRef: reference(operation) });
const unknown = (operation: PreparationOperation, code: string) => ({ kind: 'unknown' as const, code, nativeOperationRef: reference(operation) });
const ready = (snapshotName: string, operation: PreparationOperation) => ({ kind: 'ready' as const,
  artifact: reference({ operationId: operation.operationId, builderLaunch: operation.launch, snapshotName, launch: { snapshotName } }) });

/** One finite build uses the host's admitted observation cadence. Inspection is
 * recovery-only: it never reruns setup, captures another image or cleans up. */
export function createCloudPreparation(client: Client, waitForNativeObservation: () => Promise<void>) {
  async function builder(operation: PreparationOperation) {
    try { return await client.locate({ managedId: 'prepare-' + operation.operationId, launch: operation.launch,
      ...(operation.sandboxName ? { sandboxName: operation.sandboxName } : {}) }); }
    catch (error) { if (error instanceof CloudError && error.status === 404) return undefined; throw error; }
  }
  async function captured(operation: PreparationOperation) {
    try {
      if (operation.snapshotName) {
        const found = snapshot(body(await client.management(operation.snapshotName)));
        if (found.name !== operation.snapshotName) return invalidResponse();
        return found;
      }
      const matches = (await client.list('snapshots')).map(snapshot).filter(item => item.displayName === displayName(operation.operationId));
      if (matches.length > 1) throw new CloudError('docker_cloud_snapshot_identity_unconfirmed');
      return matches[0];
    } catch (error) { if (error instanceof CloudError && error.status === 404) return undefined; throw error; }
  }
  async function inspect(operation: PreparationOperation) {
    try {
      const [guest, image] = await Promise.all([builder(operation), captured(operation)]);
      const retained = { ...operation, ...(guest ? { sandboxName: guest.name } : {}), ...(image ? { snapshotName: image.name } : {}) };
      if (guest) return { kind: 'failed' as const, code: 'docker_cloud_cleanup_required', nativeOperationRef: reference(retained) };
      if (!image || image.status === 'deleted') return { kind: 'absent' as const };
      if (image.status === 'ready') return ready(image.name, retained);
      if (image.status === 'creating') return pending(retained);
      return { kind: 'failed' as const, code: 'docker_cloud_snapshot_failed', nativeOperationRef: reference(retained) };
    } catch (error) { return unknown(operation, cloudCode(error)); }
  }
  async function build(operationId: string, input: PreparationInput) {
    await client.authorize();
    let operation: PreparationOperation = { operationId, launch: input.launch.choices };
    try {
      let acquired = await client.acquire(operation.launch, 'prepare-' + operationId);
      if (acquired.kind === 'rejected') return { kind: 'refused' as const, code: acquired.code };
      while (acquired.kind === 'pending') {
        operation = { ...operation, sandboxName: acquired.nativeOperationRef.value.sandboxName };
        await waitForNativeObservation();
        acquired = await client.recover(acquired.nativeOperationRef.value);
      }
      if (acquired.kind !== 'bound') return unknown(operation, 'docker_cloud_builder_identity_unconfirmed');
      operation = { ...operation, sandboxName: acquired.resource.value.sandboxName };
      const resource = { sandboxName: operation.sandboxName! };
      const directory = '/tmp/.happier-preparation-' + encodeURIComponent(operationId);
      const run = async (argv: readonly string[]) => {
        const result = await client.execute(resource, argv);
        if (result.exitCode !== 0 || result.incomplete) throw new CloudError('docker_cloud_setup_failed');
      };
      await run(['mkdir', '-p', directory]);
      for (const file of input.cli.files) await client.putFile(resource, directory + '/' + file.path, Buffer.from(file.contentsBase64, 'base64'), 0o600);
      // Supplier-selected CLI installation and recipe-owner setup run in the
      // image only. No enrollment, daemon, Agent or Account credential is baked.
      await run(['sh', '-eu', '-c', 'trap \'rm -rf -- "$1"\' EXIT\n'
        + buildMachineProvisionerPreparationInstallScript({ cli: input.cli, stageDirectory: directory, setupScript: input.setupScript }),
        'happier-prepare', directory]);
      let image = snapshot(body(await client.management(resource.sandboxName + '/snapshots', 'POST', {
        displayName: displayName(operationId), captureMode: 'disk',
      }, { 'Idempotency-Key': operationId })));
      operation = { ...operation, snapshotName: image.name };
      while (image.status === 'creating') {
        await waitForNativeObservation();
        const next = await captured(operation);
        if (!next) return unknown(operation, 'docker_cloud_snapshot_absent');
        image = next;
      }
      if (image.status !== 'ready') return unknown(operation, 'docker_cloud_snapshot_failed');
      // Delete once, then observe. A 202 does not authorize a new build or a
      // second setup run. Native absence proves the billed builder is gone.
      const removed = await client.destroy(resource);
      if (removed.kind !== 'confirmed' && removed.code) return unknown(operation, removed.code);
      while (await builder(operation)) await waitForNativeObservation();
      return ready(image.name, operation);
    } catch (error) { return unknown(operation, cloudCode(error)); }
  }
  async function destroy(operation: PreparationOperation) {
    let retained = operation;
    try {
      const image = await captured(operation);
      if (image && image.status !== 'deleted') {
        retained = { ...retained, snapshotName: image.name };
        await client.management(image.name, 'DELETE', undefined, { 'If-Match': image.etag });
        const after = await captured(retained);
        if (after && after.status !== 'deleted') return pending(retained);
      }
      const guest = await builder(operation);
      if (guest) {
        retained = { ...retained, sandboxName: guest.name };
        const removed = await client.destroy({ sandboxName: guest.name });
        if (removed.kind !== 'confirmed') return removed.code ? unknown(retained, removed.code) : pending(retained);
      }
      return { kind: 'confirmed' as const };
    } catch (error) { return unknown(retained, cloudCode(error)); }
  }
  return { build, inspect, destroy };
}

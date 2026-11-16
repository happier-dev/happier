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

/** Native phases only. Preset/account/CLI freshness and credential-free script
 * composition belong to S1; no enrollment or Agent materialization occurs here. */
export function createCloudPreparation(client: Client) {
  async function inspect(operation: PreparationOperation) {
    if (operation.phase === 'destroying') {
      const removed = await destroy(operation);
      return removed.kind === 'confirmed' ? { kind: 'absent' as const } : removed;
    }
    let current = operation;
    try {
      if (current.phase === 'setup-unknown') return { kind: 'failed' as const, code: 'docker_cloud_setup_unconfirmed', nativeOperationRef: reference(current) };
      if (!current.input) return unknown(current, 'docker_cloud_build_input_unavailable');
      if (!current.sandboxName) {
        const builder = await client.locate({ managedId: 'prepare-' + current.operationId, launch: current.input.launch });
        if (!builder) return unknown(current, 'docker_cloud_builder_identity_unconfirmed');
        current = { ...current, sandboxName: builder.name };
      }
      const resource = { sandboxName: current.sandboxName! };
      if (current.phase === 'creating') {
        const builder = await client.read(resource);
        if (builder.status === 'failed') return { kind: 'failed' as const, code: 'docker_cloud_builder_failed', nativeOperationRef: reference(current) };
        if (builder.status !== 'running') return pending(current);
        // Exec has no replay identity. Losing its reply must never rerun setup.
        current = { ...current, phase: 'setup-unknown' };
        const result = await client.execute(resource, ['sh', '-eu', '-c', current.input!.setupScript]);
        if (result.exitCode !== 0 || result.incomplete) return unknown(current, 'docker_cloud_setup_failed');
        current = { ...current, phase: 'capturing' };
        const captured = snapshot(body(await client.management(resource.sandboxName + '/snapshots', 'POST', {
          displayName: displayName(current.operationId), captureMode: 'disk',
        }, { 'Idempotency-Key': current.operationId })));
        current = { ...current, snapshotName: captured.name };
      }
      if (!current.snapshotName) {
        const matches = (await client.list('snapshots')).map(snapshot).filter(item => item.displayName === displayName(current.operationId)
          && item.sandbox === current.sandboxName);
        if (matches.length !== 1) return unknown(operation, 'docker_cloud_snapshot_identity_unconfirmed');
        current = { ...current, snapshotName: matches[0]!.name };
      }
      const captured = snapshot(body(await client.management(current.snapshotName!)));
      if (captured.name !== current.snapshotName) return invalidResponse();
      if (captured.status === 'deleted') return { kind: 'failed' as const, code: 'docker_cloud_snapshot_deleted', nativeOperationRef: reference(current) };
      if (captured.status === 'failed') return { kind: 'failed' as const, code: 'docker_cloud_snapshot_failed', nativeOperationRef: reference(current) };
      if (captured.status !== 'ready') return pending(current);
      current = { ...current, phase: 'cleanup' };
      const cleaned = await client.destroy(resource);
      if (cleaned.kind !== 'confirmed') return pending(current);
      return { kind: 'ready' as const, artifact: reference({ snapshotName: captured.name }) };
    } catch (error) { return unknown(current, cloudCode(error)); }
  }
  async function build(operationId: string, input: PreparationInput) {
    await client.authorize();
    let operation: PreparationOperation = { operationId, input, phase: 'creating' };
    const created = await client.acquire(input.launch, 'prepare-' + operationId);
    if (created.kind === 'rejected') return { kind: 'refused' as const, code: created.code };
    if (created.kind === 'bound') operation = { ...operation, sandboxName: created.resource.value.sandboxName };
    else if (created.kind === 'pending') operation = { ...operation, sandboxName: created.nativeOperationRef.value.sandboxName };
    else return unknown(operation, 'docker_cloud_builder_identity_unconfirmed');
    if (created.kind !== 'bound') return pending(operation);
    const result = await inspect(operation);
    // Build's public union uses unknown rather than inspect's failed/absent.
    return result.kind === 'failed' ? unknown(result.nativeOperationRef.value, result.code)
      : result.kind === 'absent' ? unknown(operation, 'docker_cloud_snapshot_absent') : result;
  }
  async function destroy(operation: PreparationOperation) {
    let current = { ...operation, phase: 'destroying' as const };
    try {
      if (!current.snapshotName && operation.phase === 'capturing') {
        const matches = (await client.list('snapshots')).map(snapshot).filter(item => item.displayName === displayName(current.operationId)
          && item.sandbox === current.sandboxName);
        if (matches.length !== 1) return unknown(operation, 'docker_cloud_snapshot_identity_unconfirmed');
        current = { ...current, snapshotName: matches[0]!.name };
      }
      if (current.snapshotName) {
        try {
          const found = snapshot(body(await client.management(current.snapshotName)));
          if (found.name !== current.snapshotName) return invalidResponse();
          if (found.status !== 'deleted') {
            const removed = await client.management(found.name, 'DELETE', undefined, { 'If-Match': found.etag });
            if (removed.status !== 204) return pending(current);
          }
        } catch (error) { if (!(error instanceof CloudError && error.status === 404)) throw error; }
      }
      if (!current.sandboxName && current.input) {
        const found = await client.locate({ managedId: 'prepare-' + current.operationId, launch: current.input.launch });
        if (!found) return unknown(current, 'docker_cloud_builder_identity_unconfirmed');
        current = { ...current, sandboxName: found.name };
      }
      if (current.sandboxName && (await client.destroy({ sandboxName: current.sandboxName })).kind !== 'confirmed') return pending(current);
      return { kind: 'confirmed' as const };
    } catch (error) { return unknown(current, cloudCode(error)); }
  }
  return { build, inspect, destroy };
}

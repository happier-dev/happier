import { describe, expect, it, vi } from 'vitest';
import type { App, Image, ModalClient } from 'modal';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createModalPreparationClient, createModalPreparationRoles, MODAL_PREPARATION_SCHEMAS, type ModalPreparationClient } from './preparation.js';

const launch = { appReference: 'selected', imageReference: 'ubuntu:24.04', resources: { cpu: 0.125, memoryMb: 128 }, timeoutMs: 300000 };
const input = { operationId: 'operation-one', input: { launch: { provider: { pluginId: 'happier.machine.modal', localId: 'modal' }, schemaVersion: 1, choices: launch },
  cli: { identity: 'release:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier', installScript: 'printf CLI',
    files: [{ path: 'payload.tar.gz', contentsBase64: 'AAEC' }] }, setupScript: 'printf SETUP' } };
function boundary() {
  let exit: number | null = 0;
  let deleted = false;
  const image = { imageId: 'im-built' } as Image; // Opaque vendor handle at the SDK boundary.
  const sandbox = { sandboxId: 'sb-build', poll: vi.fn(async () => exit),
    stdin: { writeBytes: vi.fn(async (_data: Uint8Array) => {}), close: vi.fn(async () => {}) },
    filesystem: { writeBytes: vi.fn(async (_data: Uint8Array, _path: string) => {}) },
    terminate: vi.fn(async () => { exit = 137; }), experimentalGetExitSnapshot: vi.fn(async () => image) };
  const client: ModalPreparationClient = { apps: { fromName: vi.fn(async () => ({ appId: 'ap-selected' }) as App) },
    images: { fromRegistry: vi.fn(() => ({ imageId: 'im-base' }) as Image),
      fromId: vi.fn(async () => { if (deleted) throw Object.assign(new Error('private'), { name: 'NotFoundError' }); return image; }),
      delete: vi.fn(async () => { deleted = true; }) },
    sandboxes: { create: vi.fn(async () => sandbox), fromId: vi.fn(async () => sandbox) },
    listBuilds: vi.fn(async function* () { yield sandbox; }) };
  return { client, sandbox, roles: createModalPreparationRoles(client), setExit(value: number | null) { exit = value; } };
}
describe('Modal native preparation', () => {
  it('recovers finished sandboxes through the pinned native list boundary with App and operation scope', async () => {
    const { client, sandbox } = boundary();
    const sandboxList = vi.fn().mockResolvedValueOnce({ sandboxes: [{ id: sandbox.sandboxId, createdAt: 123 }] })
      .mockResolvedValueOnce({ sandboxes: [] });
    // Partial external SDK transport fixture; real list adaptation remains live.
    const sdk = { ...client, profile: { sandboxV2: false }, cpClient: { sandboxList } } as unknown as ModalClient;
    const adapted = createModalPreparationClient(sdk);
    const found = [];
    for await (const item of adapted.listBuilds('ap-selected', input.operationId)) found.push(item.sandboxId);
    expect(found).toEqual(['sb-build']);
    expect(sandboxList).toHaveBeenNthCalledWith(1, { appId: 'ap-selected', includeFinished: true,
      tags: [{ tagName: 'happier.prepare-id', tagValue: input.operationId }] });
    expect(sandboxList).toHaveBeenNthCalledWith(2, expect.objectContaining({ beforeTimestamp: 123 }));
  });
  it('builds a clean CLI/setup entrypoint and returns a launchable exit image', async () => {
    const { client, roles, sandbox } = boundary();
    const result = MODAL_PREPARATION_SCHEMAS.buildResult.parse(await roles.prepareBuild(input));
    expect(result).toMatchObject({ kind: 'ready', artifact: { value: { imageId: 'im-built', sandboxId: 'sb-build',
      launch: { ...launch, preparedImageId: 'im-built' } } } });
    const request = vi.mocked(client.sandboxes.create).mock.calls[0]![2]!;
    expect(request).toMatchObject({ experimentalOptions: { enable_exit_snapshot: true },
      tags: { 'happier.prepare-id': input.operationId }, cpu: launch.resources.cpu, memoryMiB: launch.resources.memoryMb });
    expect(request.command?.join('\n')).not.toContain('AAEC');
    expect([...sandbox.filesystem.writeBytes.mock.calls[0]![0]]).toEqual([0, 1, 2]);
    const script = sandbox.filesystem.writeBytes.mock.calls.find(([, path]) => path.endsWith('.sh'))?.[0];
    expect(new TextDecoder().decode(script)).toContain('printf CLI');
    expect(new TextDecoder().decode(script)).toContain('printf SETUP');
    expect(new TextDecoder().decode(script)).toContain('x86_64');
    expect(sandbox.stdin.close).toHaveBeenCalledOnce();
  });
  it('recovers a lost create response through the finished App-scoped operation tag, without another create', async () => {
    const { client, roles } = boundary();
    vi.mocked(client.sandboxes.create).mockRejectedValueOnce(new Error('private response lost'));
    const first = await roles.prepareBuild(input);
    expect(first).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { operationId: input.operationId } } });
    const recovered = await roles.prepareInspect({ operationId: input.operationId, launch });
    expect(recovered).toMatchObject({ kind: 'ready', artifact: { value: { imageId: 'im-built' } } });
    expect(client.listBuilds).toHaveBeenCalledWith('ap-selected', input.operationId);
    expect(client.sandboxes.create).toHaveBeenCalledTimes(1);
  });
  it.skipIf(process.platform === 'win32').each([
    { outcome: 'successful', installScript: 'test "$(id -u)" = 0', expectedExit: 0 },
    { outcome: 'failed', installScript: 'false', expectedExit: 1 },
  ])('preserves $outcome CLI installation and runs canonical Setup with root privilege', async ({ installScript, expectedExit }) => {
    const directory = mkdtempSync(join(tmpdir(), 'modal-preparation-user-'));
    const uploaded: string[] = [];
    try {
      // Guest OS boundary: emulate a non-root image and passwordless sudo
      // without changing the test host's user or /opt directory.
      writeFileSync(join(directory, 'id'), '#!/bin/sh\nprintf "%s\\n" "${TEST_GUEST_UID:-1000}"\n', { mode: 0o755 });
      writeFileSync(join(directory, 'sudo'), '#!/bin/sh\nshift 2\nexport TEST_GUEST_UID=0\nexec "$@"\n', { mode: 0o755 });
      writeFileSync(join(directory, 'chmod'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(directory, 'uname'), '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo x86_64; fi\n', { mode: 0o755 });
      const { client, roles, sandbox } = boundary();
      vi.mocked(sandbox.filesystem.writeBytes).mockImplementation(async (data, path) => {
        uploaded.push(path);
        writeFileSync(path, data);
      });
      await roles.prepareBuild({ ...input, operationId: basename(directory), input: { ...input.input,
        cli: { ...input.input.cli, files: [], installScript },
        setupScript: 'test "$(id -u)" = 0' } });
      const command = vi.mocked(client.sandboxes.create).mock.calls[0]![2]!.command!;
      const run = spawnSync(command[0]!, command.slice(1), { env: { ...process.env, PATH: directory + ':' + process.env.PATH,
        TEST_GUEST_UID: '1000' }, input: Buffer.concat(sandbox.stdin.writeBytes.mock.calls.map(([bytes]) => Buffer.from(bytes))) });
      expect(run.status, run.stderr.toString()).toBe(expectedExit);
    } finally {
      for (const path of uploaded) rmSync(path, { force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('retains cancelled late custody and deletes the resulting owned image only after compute ends', async () => {
    const { client, sandbox, setExit } = boundary();
    setExit(null);
    const abort = new AbortController();
    vi.mocked(client.sandboxes.create).mockImplementationOnce(async () => { abort.abort(); return sandbox; });
    const roles = createModalPreparationRoles(client, abort.signal);
    const result = await roles.prepareBuild(input);
    expect(result).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { sandboxId: 'sb-build' } } });
    if (result.kind !== 'unknown') throw new Error('Expected retained cancellation custody');
    const cleanup = createModalPreparationRoles(client);
    expect(await cleanup.prepareDestroy({ nativeOperation: result.nativeOperationRef })).toEqual({ kind: 'confirmed' });
    expect(sandbox.terminate).toHaveBeenCalledOnce();
    expect(client.images.delete).toHaveBeenCalledWith('im-built');
  });
  it('retains source custody without triggering setup when native payload upload is unconfirmed', async () => {
    const { roles, sandbox } = boundary();
    sandbox.filesystem.writeBytes.mockRejectedValueOnce(new Error('private transfer failure'));
    expect(await roles.prepareBuild(input)).toMatchObject({ kind: 'unknown',
      nativeOperationRef: { value: { sandboxId: 'sb-build', operationId: input.operationId } } });
    expect(sandbox.stdin.writeBytes).not.toHaveBeenCalled();
  });
  it('never treats a failed setup, pending snapshot, or absent inventory as a ready artifact', async () => {
    const { roles, client, sandbox, setExit } = boundary();
    setExit(7);
    expect(await roles.prepareBuild(input)).toMatchObject({ kind: 'unknown', code: 'modal_preparation_setup_failed' });
    setExit(0);
    vi.mocked(sandbox.experimentalGetExitSnapshot).mockRejectedValueOnce(Object.assign(new Error('private'), { name: 'TimeoutError' }));
    expect(await roles.prepareInspect({ operationId: input.operationId, launch })).toMatchObject({ kind: 'pending' });
    vi.mocked(client.listBuilds).mockImplementation(async function* () {});
    expect(await roles.prepareInspect({ operationId: input.operationId, launch })).toMatchObject({ kind: 'unknown' });
  });
  it('does not confirm deletion while the image remains natively readable', async () => {
    const { roles, client } = boundary();
    const result = await roles.prepareBuild(input);
    if (result.kind !== 'ready') throw new Error('Expected image');
    vi.mocked(client.images.delete).mockResolvedValueOnce(undefined);
    expect(await roles.prepareDestroy({ artifact: result.artifact })).toMatchObject({ kind: 'pending' });
  });
  it('does not delete an image unrelated to the owned source Sandbox exit snapshot', async () => {
    const { roles, client } = boundary();
    const result = await roles.prepareBuild(input);
    if (result.kind !== 'ready') throw new Error('Expected image');
    expect(await roles.prepareDestroy({ artifact: { ...result.artifact, value: { ...result.artifact.value, imageId: 'im-unrelated' } } }))
      .toMatchObject({ kind: 'refused', code: 'modal_preparation_identity_mismatch' });
    expect(client.images.delete).not.toHaveBeenCalled();
  });
  it('requires the retained Sandbox to belong to the App-scoped operation tag before deleting', async () => {
    const { roles, client } = boundary();
    const result = await roles.prepareBuild(input);
    if (result.kind !== 'ready') throw new Error('Expected image');
    vi.mocked(client.listBuilds).mockImplementation(async function* () {});
    expect(await roles.prepareDestroy({ artifact: result.artifact })).toMatchObject({ kind: 'unknown' });
    expect(client.images.delete).not.toHaveBeenCalled();
  });
});

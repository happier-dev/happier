import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ManagedMachinePresetPreparationBuildInputV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationBuildInputV1';
import { prepareManagedGuestCliBuildInput } from '../../systemTasks/ssh/managedGuestCliSupplier.js';
import { ManagedMachinePresetV1Schema, type ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { openManagedMachinePresetContentV1, sealManagedMachinePresetContentV1,
  projectManagedMachinePresetForRecipientV1, replaceManagedMachinePresetAuthorContentV1,
  type ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { deriveBoxPublicKeyFromSeed, deriveBoxSecretKeyFromSeed } from '@happier-dev/protocol/crypto/boxBundle';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { SavedSecretResourceEnvelopeCensusRecipientV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { MachineProvisionerNativeCauseV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { readManagedMachinePresetPreparationV1 } from './presetPreparation.js';
import { ManagedMachineNativeEffectGuardRefusal } from './controllerErrors.js';
import { advanceManagedMachinePresetPreparationOperationV1, cancelManagedMachinePresetPreparationOperationV1,
  settleManagedMachinePresetPreparationOperationV1,
  type ManagedMachinePresetPreparationCustodyV1, type ManagedMachinePresetPreparationStorageV1,
  type ManagedMachinePresetPreparationNativeV1, type ManagedMachinePresetPreparationRootV1 } from './presetPreparationOperation.js';

const definition: ManagedMachinePresetContentV1 = { v: 1, name: 'Private preset', preparation: { enabled: true },
  launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1,
    name: 'Guest', choices: { image: 'clean-base' } } };
const artifact = { contributionRef: definition.launch!.provider, schemaVersion: 1, value: { image: 'owned-image' } };
const nativeOperationRef = { ...artifact, value: { name: 'build-operation-one' } };
const identity = { credentialConfigurations: [], expectedRevision: 1, cliIdentity: `home-payload:${'a'.repeat(64)}` };
let buildInput: ManagedMachinePresetPreparationBuildInputV1;
beforeAll(async () => {
  const cli = await prepareManagedGuestCliBuildInput({ homeUrl: 'https://private-home.example',
    target: { os: 'linux', arch: 'x64' }, remoteHomeDir: '/opt/happier',
    fetchImpl: async () => Response.json({ capabilities: { guestCli: { source: 'home-payload', line: '0.3', channel: 'stable' } } }),
    prepareLocalPayload: async () => ({ identity: 'a'.repeat(64), versionId: '0.3.0', target: { os: 'linux', arch: 'x64' },
      archive: { contentsBase64: 'cGF5bG9hZA==', rootDirectory: 'payload' } }),
  });
  const { provider, schemaVersion, choices } = definition.launch!;
  buildInput = { launch: { provider, schemaVersion, choices }, cli };
});

/** The network persistence boundary retains the real mode-tagged private content. */
function storageFixture(custody: ManagedMachinePresetPreparationCustodyV1 = { mode: 'plain' },
  content: ManagedMachinePresetContentV1 = definition, revision = 1) {
  const seed = new Uint8Array(32).fill(71);
  const publicKey = deriveBoxPublicKeyFromSeed(seed);
  const sealed = custody.mode === 'plain' ? { content: { t: 'plain', v: content }, recipients: [] }
    : sealManagedMachinePresetContentV1({ presetId: 'preset', ...custody, content,
      recipientCensus: [SavedSecretResourceEnvelopeCensusRecipientV1Schema.parse({
        account: { kind: 'account', accountId: 'owner', name: 'Owner', firstName: 'Owner', lastName: null, username: null, avatarUrl: null },
        readiness: { status: 'available', contentPublicKey: encodeBase64(publicKey, 'base64'),
          contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) }, envelopeStatus: 'missing',
      })] });
  let row = ManagedMachinePresetV1Schema.parse({ id: 'preset', homeId: 'home', revision,
    owner: { kind: 'account', accountId: 'owner' }, contentEncryptionMode: custody.mode, ...sealed });
  const writes: ManagedMachinePresetV1[] = [];
  const storage: ManagedMachinePresetPreparationStorageV1 = {
    read: async () => row,
    compareAndSwap: async replacement => {
      if (replacement.expectedRevision !== row.revision) return { kind: 'conflict', currentRevision: row.revision };
      row = ManagedMachinePresetV1Schema.parse({ ...row, revision: row.revision + 1,
        content: replacement.content, recipients: replacement.recipients });
      writes.push(row);
      return { kind: 'saved', preset: row };
    },
  };
  const opened = () => (custody.mode === 'plain'
    ? openManagedMachinePresetContentV1({ presetId: row.id, mode: 'plain', content: row.content })
    : openManagedMachinePresetContentV1({ presetId: row.id, ...custody, content: row.content, recipients: row.recipients }))!;
  return { storage, writes, opened, row: () => row };
}

function nativeFixture(overrides: Partial<ManagedMachinePresetPreparationNativeV1> = {}): ManagedMachinePresetPreparationNativeV1 {
  return { build: async () => ({ kind: 'ready', artifact }), inspect: async () => ({ kind: 'ready', artifact }),
    destroy: async () => ({ kind: 'confirmed' }), ...overrides };
}

async function editAuthor(fixture: ReturnType<typeof storageFixture>, content: ManagedMachinePresetContentV1) {
  const edited = replaceManagedMachinePresetAuthorContentV1({ presetId: 'preset', mode: 'plain',
    projection: projectManagedMachinePresetForRecipientV1({ ...fixture.row(), recipientAccountId: 'owner' }), content });
  if (!edited) throw new Error('The author edit must be valid');
  return await fixture.storage.compareAndSwap({ expectedRevision: fixture.row().revision,
    content: edited.content, recipients: [...edited.recipients] });
}

describe('private preset preparation operation', () => {
  it('archives a preparation whose build handler was refused before dispatch', async () => {
    const fixture = storageFixture();
    const operation = { ...identity, operationId: 'retired-generation-build', custody: { mode: 'plain' as const },
      storage: fixture.storage, composeBuild: async () => ({ input: buildInput }) };
    const inspect = vi.fn(async (): Promise<never> => { throw new Error('No native build identifier was issued'); });
    const destroy = vi.fn(async (): Promise<never> => { throw new Error('No native image was submitted'); });
    const native = { inspect, destroy,
      build: async () => { throw new ManagedMachineNativeEffectGuardRefusal('plugin_action_generation_retired'); } };
    await expect(settleManagedMachinePresetPreparationOperationV1({ ...operation, native }))
      .rejects.toMatchObject({ code: 'plugin_action_generation_retired' });
    expect(fixture.opened().prepared).toMatchObject({ operationId: operation.operationId, status: 'failed',
      code: 'plugin_action_generation_retired' });
    await expect(settleManagedMachinePresetPreparationOperationV1({
      ...operation, native, expectedRevision: fixture.row().revision, cleanupOnly: true,
    })).resolves.toMatchObject({ kind: 'cancelled', prepared: { status: 'cancelled' } });
    expect(inspect).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it.each(['plain', 'e2ee'] as const)('prepares a newly created revision-zero preset in %s', async mode => {
    let nonce = 51;
    const custody: ManagedMachinePresetPreparationCustodyV1 = mode === 'plain' ? { mode }
      : { mode, accountId: 'owner', accountKey: deriveBoxSecretKeyFromSeed(new Uint8Array(32).fill(71)),
        randomBytes: length => new Uint8Array(length).fill(nonce++) };
    // Captured A4 Prepare admission used expectedRevision: 0 on a fresh preset.
    const fixture = storageFixture(custody, definition, 0);
    const outcome = await settleManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one',
      ...identity, expectedRevision: 0, custody, storage: fixture.storage,
      composeBuild: async () => ({ input: buildInput }), native: nativeFixture() });

    expect(outcome.kind).toBe('ready');
    expect(fixture.opened().prepared).toMatchObject({ status: 'ready', builtFromRevision: 0, artifact });
    expect(fixture.writes.map(row => row.revision)).toEqual([1, 2]);
  });

  it.each(['confirmed', 'refused', 'throws'] as const)('cleans up a thrown build failure without replacing its cause when cleanup %s', async cleanup => {
    const fixture = storageFixture();
    const original = new Error('SSH host trust declined');
    const effects: string[] = [];
    const reports: unknown[] = [];
    let allocated = false;
    const settling = settleManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one', ...identity,
      onProgress: progress => reports.push(progress),
      composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' }, storage: fixture.storage,
      native: nativeFixture({ build: async () => { effects.push('build'); allocated = true; throw original; },
        inspect: async input => {
          effects.push('inspect');
          expect(input).toEqual({ operationId: 'operation-one', launch: definition.launch!.choices });
          return { kind: 'pending', nativeOperationRef };
        },
        destroy: async input => {
          effects.push('destroy');
          expect(input).toEqual({ nativeOperation: nativeOperationRef });
          if (cleanup === 'throws') throw new Error('Native cleanup unavailable');
          if (cleanup === 'refused') return { kind: 'refused', code: 'cleanup_unavailable' };
          allocated = false;
          return { kind: 'confirmed' };
        } }) });
    await expect(settling).rejects.toBe(original);
    expect(reports.at(-1)).toMatchObject({ phase: 'build-image', steps: [
      { id: 'prepare-inputs', state: 'succeeded' }, { id: 'build-image', state: 'failed' }, { id: 'save-image', state: 'pending' },
    ] });
    expect(effects).toEqual(['build', 'inspect', 'destroy']);
    expect(fixture.opened().prepared).toMatchObject({ status: 'cancelled' });
    expect(allocated).toBe(cleanup !== 'confirmed');
    if (cleanup === 'confirmed') expect(fixture.opened().prepared).not.toHaveProperty('nativeOperationRef');
    else expect(fixture.opened().prepared).toHaveProperty('nativeOperationRef', nativeOperationRef);
  });

  it.each(['plain', 'e2ee'] as const)('retains setup failure through interrupted recovery, replaces a new native cause and clears it on cleanup in %s', async mode => {
    let nonce = 51;
    const custody: ManagedMachinePresetPreparationCustodyV1 = mode === 'plain' ? { mode }
      : { mode, accountId: 'owner', accountKey: deriveBoxSecretKeyFromSeed(new Uint8Array(32).fill(71)),
        randomBytes: length => new Uint8Array(length).fill(nonce++) };
    const nativeCause = { localCause: 'native_command_failed' as const, command: 'run' as const,
      exitCode: 17, stderr: 'setup failed' };
    const fixture = storageFixture(custody);
    let inspections = 0;
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), custody,
      storage: fixture.storage, native: nativeFixture({ build: async () => ({ kind: 'unknown', code: 'setup_failed',
        nativeCause, nativeOperationRef }), inspect: async () => ++inspections === 1
          ? { kind: 'pending', nativeOperationRef } : { kind: 'failed', code: 'preparation_interrupted', nativeOperationRef } }) };
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'unknown',
      prepared: { code: 'setup_failed', nativeCause, nativeOperationRef } });
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'pending',
      prepared: { code: 'setup_failed', nativeCause, nativeOperationRef } });
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'failed',
      prepared: { code: 'setup_failed', nativeCause, nativeOperationRef } });
    expect(fixture.opened().prepared).toMatchObject({ code: 'setup_failed', nativeCause });
    const deleteCause = { httpStatusClass: '4xx' as const, code: 'forbidden' as const };
    expect(await cancelManagedMachinePresetPreparationOperationV1({ ...request,
      native: nativeFixture({ destroy: async () => ({ kind: 'refused', code: 'delete_forbidden', nativeCause: deleteCause }) }) }))
      .toMatchObject({ kind: 'failed', prepared: { code: 'delete_forbidden', nativeCause: deleteCause, nativeOperationRef } });
    const cleaned = await cancelManagedMachinePresetPreparationOperationV1(request);
    expect(cleaned).toMatchObject({ kind: 'cancelled' });
    expect(fixture.opened().prepared).not.toHaveProperty('nativeCause');
    expect(fixture.opened().prepared).not.toHaveProperty('code');
  });

  it.each(['refused', 'unknown', 'failed'] as const)('persists safe native %s cause through the real private writer', async kind => {
    const fixture = storageFixture();
    const nativeCause = MachineProvisionerNativeCauseV1Schema.parse({ httpStatusClass: '4xx', code: 'resource_limit_exceeded' });
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }),
      credentialConfigurations: [], custody: { mode: 'plain' as const }, storage: fixture.storage,
      native: nativeFixture({ build: async () => kind === 'failed' ? { kind: 'pending', nativeOperationRef }
        : kind === 'refused' ? { kind, code: 'native_refused', nativeCause }
          : { kind, code: 'outcome_unknown', nativeOperationRef, nativeCause },
      inspect: async () => ({ kind: 'failed', code: 'native_failed', nativeOperationRef, nativeCause }) }) };
    await advanceManagedMachinePresetPreparationOperationV1(request);
    if (kind === 'failed') await advanceManagedMachinePresetPreparationOperationV1(request);
    expect(fixture.opened().prepared).toMatchObject({ nativeCause });
    if (kind === 'unknown') {
      await advanceManagedMachinePresetPreparationOperationV1({ ...request, native: nativeFixture() });
      expect(fixture.opened().prepared).not.toHaveProperty('nativeCause');
      expect(fixture.opened().prepared).not.toHaveProperty('code');
    }
  });

  it.each(['refused', 'unknown'] as const)('retains safe destroy %s cause until confirmed cleanup clears it', async kind => {
    const fixture = storageFixture();
    const nativeCause = MachineProvisionerNativeCauseV1Schema.parse({ sdkError: 'ResourceExhaustedError' });
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }),
      credentialConfigurations: [], custody: { mode: 'plain' as const }, storage: fixture.storage, native: nativeFixture() };
    await advanceManagedMachinePresetPreparationOperationV1(request);
    await cancelManagedMachinePresetPreparationOperationV1({ ...request, native: nativeFixture({ destroy: async () =>
      kind === 'refused' ? { kind, code: 'native_refused', nativeCause }
        : { kind, code: 'outcome_unknown', nativeOperationRef, nativeCause } }) });
    expect(fixture.opened().prepared).toMatchObject({ status: 'cancelled', artifact, nativeCause });
    await cancelManagedMachinePresetPreparationOperationV1(request);
    expect(fixture.opened().prepared).not.toHaveProperty('nativeCause');
    expect(fixture.opened().prepared).not.toHaveProperty('code');
  });

  it('retains the classified original cause across generic inspect failure but clears it for a new build', async () => {
    const fixture = storageFixture();
    const nativeCause = MachineProvisionerNativeCauseV1Schema.parse({ localCause: 'native_command_failed', command: 'create', exitCode: 1 });
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }),
      credentialConfigurations: [], custody: { mode: 'plain' as const }, storage: fixture.storage,
      native: nativeFixture({ build: async () => ({ kind: 'unknown', code: 'outcome_unknown', nativeOperationRef, nativeCause }),
        inspect: async () => ({ kind: 'failed', code: 'interrupted', nativeOperationRef }) }) };
    await advanceManagedMachinePresetPreparationOperationV1(request);
    await advanceManagedMachinePresetPreparationOperationV1(request);
    expect(fixture.opened().prepared).toMatchObject({ status: 'failed', nativeCause });
    await settleManagedMachinePresetPreparationOperationV1({ ...request, operationId: 'operation-two',
      expectedRevision: fixture.row().revision, native: nativeFixture({ build: async () => {
        expect(fixture.opened().prepared).not.toHaveProperty('nativeCause');
        return { kind: 'ready', artifact };
      } }) });
    expect(fixture.opened().prepared).not.toHaveProperty('nativeCause');
  });

  it.each(['plain', 'e2ee'] as const)('retains the actual supplier CLI path before build and exposes it only after ready in %s', async mode => {
    let nonce = 23;
    const custody: ManagedMachinePresetPreparationCustodyV1 = mode === 'plain' ? { mode }
      : { mode, accountId: 'owner', accountKey: deriveBoxSecretKeyFromSeed(new Uint8Array(32).fill(71)),
        randomBytes: length => new Uint8Array(length).fill(nonce++) };
    const fixture = storageFixture(custody);
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), custody, storage: fixture.storage,
      native: nativeFixture({ build: async () => {
        expect(fixture.opened().prepared).toMatchObject({ status: 'building', cliBinaryPath: buildInput.cli.binaryPath });
        return { kind: 'pending', nativeOperationRef };
      } }) };
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'pending' });
    expect(readManagedMachinePresetPreparationV1({ content: fixture.opened(), ...identity }))
      .toEqual({ kind: 'cold', reason: 'building' });
    expect(await advanceManagedMachinePresetPreparationOperationV1({ ...request,
      composeBuild: async () => ({ input: { ...buildInput, cli: { ...buildInput.cli, binaryPath: '/different-current-cli/happier' } },
        bakedSetup: { scripts: [{ body: 'unrelated-retry-setup', affects: 'none' }] } }) }))
      .toMatchObject({ kind: 'ready', prepared: { cliBinaryPath: buildInput.cli.binaryPath } });
    expect(fixture.opened().prepared).not.toHaveProperty('bakedSetup');
    expect(readManagedMachinePresetPreparationV1({ content: fixture.opened(), ...identity }))
      .toMatchObject({ kind: 'warm', binaryPath: buildInput.cli.binaryPath });
  });
  it.each(['plain', 'e2ee'] as const)('persists native inspection storage bytes without inventing an estimate in %s', async mode => {
    let nonce = 23;
    const custody: ManagedMachinePresetPreparationCustodyV1 = mode === 'plain' ? { mode }
      : { mode, accountId: 'owner', accountKey: deriveBoxSecretKeyFromSeed(new Uint8Array(32).fill(71)),
        randomBytes: length => new Uint8Array(length).fill(nonce++) };
    const fixture = storageFixture(custody);
    const reports: unknown[] = [];
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), custody, storage: fixture.storage,
      onProgress: (progress: unknown) => reports.push(progress),
      native: nativeFixture({ build: async () => ({ kind: 'pending', nativeOperationRef }),
        inspect: async () => ({ kind: 'ready', artifact, artifactSizeBytes: 1024 }) }) };
    await advanceManagedMachinePresetPreparationOperationV1(request);
    expect(fixture.opened().prepared).not.toHaveProperty('artifactSizeBytes');
    await advanceManagedMachinePresetPreparationOperationV1(request);
    expect(fixture.opened().prepared).toMatchObject({ status: 'ready', artifactSizeBytes: 1024,
      builtFromRevision: 1, builtAt: expect.any(Number) });
    expect(reports).toContainEqual(expect.objectContaining({ phase: 'prepare-inputs', steps: [
      expect.objectContaining({ id: 'prepare-inputs', label: expect.any(String), state: 'running' }),
      expect.objectContaining({ id: 'build-image', state: 'pending' }),
      expect.objectContaining({ id: 'save-image', state: 'pending' }),
    ] }));
    expect(reports.at(-1)).toMatchObject({ steps: [
      { id: 'prepare-inputs', state: 'succeeded' }, { id: 'build-image', state: 'succeeded' }, { id: 'save-image', state: 'succeeded' },
    ] });
    const ready = fixture.opened().prepared;
    await advanceManagedMachinePresetPreparationOperationV1(request);
    expect(fixture.opened().prepared).toEqual(ready);
  });
  it('foreground following retains the operation until native readiness and leaves no settled timer', async () => {
    vi.useFakeTimers();
    try {
      const fixture = storageFixture();
      let inspections = 0;
      const settling = settleManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one', ...identity,
        composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' }, storage: fixture.storage,
        native: nativeFixture({ build: async () => ({ kind: 'pending', nativeOperationRef }),
          inspect: async () => { inspections++; return { kind: 'ready', artifact }; } }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.opened().prepared).toMatchObject({ status: 'building', nativeOperationRef });
      expect(inspections).toBe(0);
      await vi.advanceTimersToNextTimerAsync();
      expect(await settling).toMatchObject({ kind: 'ready', prepared: { artifact } });
      expect(inspections).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('foreground Stop keeps the owner alive until the same native cleanup confirms absence', async () => {
    vi.useFakeTimers();
    try {
      const fixture = storageFixture();
      const stop = new AbortController();
      let destroys = 0;
      let settled = false;
      const settling = settleManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one', ...identity,
        composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' }, storage: fixture.storage, signal: stop.signal,
        native: nativeFixture({ build: async () => ({ kind: 'pending', nativeOperationRef }),
          destroy: async input => {
            expect(input).toEqual({ nativeOperation: nativeOperationRef });
            return ++destroys === 1 ? { kind: 'unknown', code: 'outcome_unknown', nativeOperationRef } : { kind: 'confirmed' };
          } }) }).then(result => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(0);
      stop.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.opened().prepared).toMatchObject({ status: 'cancelled', nativeOperationRef });
      expect(settled).toBe(false);
      await vi.advanceTimersToNextTimerAsync();
      expect(await settling).toMatchObject({ kind: 'cancelled' });
      expect(fixture.opened().prepared).not.toHaveProperty('nativeOperationRef');
      expect(destroys).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['plain', 'e2ee'] as const)('Archive cleanup follows owned absence and leaves the restorable definition cold in %s', async mode => {
    vi.useFakeTimers();
    try {
      let nonce = 80;
      const custody: ManagedMachinePresetPreparationCustodyV1 = mode === 'plain' ? { mode }
        : { mode, accountId: 'owner', accountKey: deriveBoxSecretKeyFromSeed(new Uint8Array(32).fill(71)),
          randomBytes: length => new Uint8Array(length).fill(nonce++) };
      const fixture = storageFixture(custody);
      await advanceManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one', ...identity, custody,
        composeBuild: async () => ({ input: buildInput }), storage: fixture.storage, native: nativeFixture() });
      const recipients = fixture.row().recipients;
      const originalLaunch = fixture.opened().prepared!.binding.configuration.launch;
      let destroys = 0;
      const archive = { operationId: 'archive-operation', ...identity, expectedRevision: fixture.row().revision,
        cleanupOnly: true as const, custody, storage: fixture.storage,
        native: nativeFixture({ build: async () => { throw new Error('Archive must not build'); },
          destroy: async (input, root) => {
            expect(input.artifact).toEqual(artifact);
            expect(root).toMatchObject({ operationId: 'operation-one', launch: originalLaunch });
            destroys++;
            return destroys === 1 ? { kind: 'refused', code: 'provider_unavailable' }
              : destroys === 2 ? { kind: 'unknown', code: 'outcome_unknown', nativeOperationRef }
                : { kind: 'confirmed' };
          } }) };
      expect(await settleManagedMachinePresetPreparationOperationV1(archive)).toMatchObject({ kind: 'failed',
        prepared: { operationId: 'operation-one', status: 'cancelled', artifact } });
      let settled = false;
      const retry = settleManagedMachinePresetPreparationOperationV1({ ...archive, expectedRevision: fixture.row().revision })
        .then(result => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(fixture.opened().prepared).toMatchObject({ status: 'cancelled', artifact, nativeOperationRef });
      await vi.advanceTimersToNextTimerAsync();
      expect(await retry).toMatchObject({ kind: 'cancelled', revision: fixture.row().revision });
      const restorable = fixture.opened();
      expect(restorable.launch).toEqual(definition.launch);
      expect(restorable.preparation).toEqual({ enabled: true });
      expect(restorable.prepared).not.toHaveProperty('artifact');
      expect(restorable.prepared).not.toHaveProperty('nativeOperationRef');
      expect(readManagedMachinePresetPreparationV1({ content: restorable, ...identity })).toEqual({ kind: 'cold', reason: 'cancelled' });
      expect(fixture.row().recipients).toEqual(recipients);
      expect(destroys).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['plain', 'e2ee'] as const)('Archive retains manual cleanup references and restores cold when its original host is permanently gone in %s', async mode => {
    let nonce = 90;
    const custody: ManagedMachinePresetPreparationCustodyV1 = mode === 'plain' ? { mode }
      : { mode, accountId: 'owner', accountKey: deriveBoxSecretKeyFromSeed(new Uint8Array(32).fill(71)),
        randomBytes: length => new Uint8Array(length).fill(nonce++) };
    const fixture = storageFixture(custody);
    const original = { operationId: 'operation-one', ...identity, machineId: 'original-prepare-host', custody,
      composeBuild: async () => ({ input: buildInput }), storage: fixture.storage,
      native: nativeFixture({ build: async () => ({ kind: 'pending', nativeOperationRef }) }) };
    await advanceManagedMachinePresetPreparationOperationV1(original);
    await advanceManagedMachinePresetPreparationOperationV1(original);
    const prepared = fixture.opened().prepared!;
    const recipients = fixture.row().recipients;
    const expectedRevision = fixture.row().revision;
    const effects: string[] = [];
    const outcome = await settleManagedMachinePresetPreparationOperationV1({ ...original,
      operationId: 'archive-operation', expectedRevision, cleanupOnly: true,
      cleanupUnavailable: mode === 'plain' ? 'machine_revoked' : 'machine_replaced',
      native: nativeFixture({
        build: async () => { effects.push('build'); return { kind: 'ready', artifact }; },
        inspect: async () => { effects.push('inspect'); return { kind: 'ready', artifact }; },
        destroy: async () => { effects.push('destroy'); return { kind: 'confirmed' }; },
      }) });
    expect(outcome).toEqual({ kind: 'cancelled', revision: expectedRevision + 1,
      prepared: { ...prepared, status: 'cancelled', code: 'preparation_cleanup_required' } });
    expect(fixture.opened().prepared).toEqual({ ...prepared, status: 'cancelled', code: 'preparation_cleanup_required' });
    expect(fixture.row().recipients).toEqual(recipients);
    expect(effects).toEqual([]);
    expect(readManagedMachinePresetPreparationV1({ content: fixture.opened(), ...identity }))
      .toEqual({ kind: 'cold', reason: 'cancelled' });
  });

  it.each([undefined, 'machine_revoked', 'machine_replaced'] as const)('Archive cleanup rejects a stale revision before native destruction (%s)', async cleanupUnavailable => {
    const fixture = storageFixture();
    await advanceManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one', ...identity,
      composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' }, storage: fixture.storage,
      native: nativeFixture() });
    let destroys = 0;
    const writes = fixture.writes.length;
    const archive = { operationId: 'archive-operation', ...identity, cleanupOnly: true as const, cleanupUnavailable,
      custody: { mode: 'plain' as const }, storage: fixture.storage,
      native: nativeFixture({ destroy: async () => { destroys++; return { kind: 'confirmed' }; } }) };
    expect(await settleManagedMachinePresetPreparationOperationV1(archive)).toEqual({ kind: 'conflict',
      currentRevision: fixture.row().revision });
    expect(destroys).toBe(0);
    expect(fixture.writes).toHaveLength(writes);
    expect(fixture.opened().prepared).toMatchObject({ status: 'ready', artifact });
  });

  it('ordinary Prepare still cleans up the old image when a cleanup-unavailable fact is supplied', async () => {
    const fixture = storageFixture();
    const original = { operationId: 'operation-one', ...identity, custody: { mode: 'plain' as const },
      composeBuild: async () => ({ input: buildInput }), storage: fixture.storage, native: nativeFixture() };
    await advanceManagedMachinePresetPreparationOperationV1(original);
    const effects: string[] = [];
    const outcome = await settleManagedMachinePresetPreparationOperationV1({ ...original,
      operationId: 'operation-two', expectedRevision: fixture.row().revision, cleanupUnavailable: 'machine_revoked',
      native: nativeFixture({
        destroy: async () => { effects.push('destroy'); return { kind: 'confirmed' }; },
        build: async () => { effects.push('build'); return { kind: 'ready', artifact }; },
      }) });
    expect(outcome).toMatchObject({ kind: 'ready', prepared: { operationId: 'operation-two', status: 'ready' } });
    expect(effects).toEqual(['destroy', 'build']);
    expect(fixture.opened().prepared).not.toHaveProperty('code');
  });

  it.each(['artifact', 'nativeOperation'] as const)('reload follows retained cancelled %s cleanup through confirmed absence', async reference => {
    vi.useFakeTimers();
    try {
      const fixture = storageFixture();
      let destroys = 0;
      let builds = 0;
      const request = { operationId: 'operation-one', ...identity,
        composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' as const }, storage: fixture.storage,
        native: nativeFixture({ build: async () => {
          builds++;
          return reference === 'artifact' ? { kind: 'ready', artifact } : { kind: 'pending', nativeOperationRef };
        }, destroy: async () => {
          destroys++;
          return destroys === 1 ? { kind: 'refused', code: 'provider_unavailable' }
            : destroys === 2 ? { kind: 'pending', nativeOperationRef } : { kind: 'confirmed' };
        } }) };
      await advanceManagedMachinePresetPreparationOperationV1(request);
      expect(await cancelManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'failed',
        prepared: { status: 'cancelled' } });
      const { composeBuild: _unavailableBuildComposition, ...reloaded } = request;
      let settled = false;
      const settling = settleManagedMachinePresetPreparationOperationV1(reloaded)
        .then(result => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(fixture.opened().prepared).toMatchObject({ status: 'cancelled', nativeOperationRef });
      await vi.advanceTimersToNextTimerAsync();
      expect(await settling).toMatchObject({ kind: 'cancelled' });
      expect(fixture.opened().prepared).not.toHaveProperty('artifact');
      expect(fixture.opened().prepared).not.toHaveProperty('nativeOperationRef');
      expect(builds).toBe(1);
      expect(destroys).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('persists the incumbent operation before build and keeps the ready binding current after the state CAS', async () => {
    const fixture = storageFixture();
    const native = nativeFixture({ build: async input => {
      expect(input).toEqual({ operationId: 'operation-one', input: buildInput });
      expect(fixture.opened().prepared).toMatchObject({ operationId: 'operation-one', status: 'building',
        binding: { cliIdentity: buildInput.cli.identity } });
      expect(fixture.opened().prepared!.binding).not.toHaveProperty('presetRevision');
      return { kind: 'ready', artifact };
    } });
    const result = await advanceManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one',
      ...identity, composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' }, storage: fixture.storage, native });
    expect(result).toMatchObject({ kind: 'ready', revision: 3, prepared: { operationId: 'operation-one', artifact } });
    expect(fixture.writes.map(row => row.revision)).toEqual([2, 3]);
    expect(readManagedMachinePresetPreparationV1({ content: fixture.opened(), ...identity }))
      .toEqual({ kind: 'warm', artifact, binaryPath: buildInput.cli.binaryPath });
  });

  it('reopens an uncertain build by its retained native identity without dispatching another paid build', async () => {
    const fixture = storageFixture();
    let builds = 0;
    const native = nativeFixture({ build: async () => { builds++; return { kind: 'unknown', code: 'outcome_unknown', nativeOperationRef }; },
      inspect: async input => {
        expect(input).toEqual({ nativeOperation: nativeOperationRef });
        return { kind: 'ready', artifact };
      } });
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' as const }, storage: fixture.storage, native };
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'unknown',
      prepared: { status: 'building', nativeOperationRef, code: 'outcome_unknown' } });
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'ready', prepared: { artifact } });
    expect(builds).toBe(1);
  });

  it.each(['plain', 'e2ee'] as const)('binds the original baked setup after recovery and never the retry subset in %s', async mode => {
    const bakedSetup = { scripts: [{ body: 'prepare-owned-package', affects: 'none' as const }] };
    const retrySetup = { scripts: [{ body: 'different-current-recipe', affects: 'none' as const }] };
    let nonce = 40;
    const custody: ManagedMachinePresetPreparationCustodyV1 = mode === 'plain' ? { mode }
      : { mode, accountId: 'owner', accountKey: deriveBoxSecretKeyFromSeed(new Uint8Array(32).fill(71)),
        randomBytes: length => new Uint8Array(length).fill(nonce++) };
    const fixture = storageFixture(custody, { ...definition, setup: bakedSetup });
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput, bakedSetup }),
      custody, storage: fixture.storage,
      native: nativeFixture({ build: async () => {
        expect(fixture.opened().prepared).toMatchObject({ status: 'building', buildSetup: bakedSetup });
        expect(fixture.opened().prepared).not.toHaveProperty('bakedSetup');
        return { kind: 'pending', nativeOperationRef };
      } }) };
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'pending' });
    expect(fixture.opened().prepared).toMatchObject({ buildSetup: bakedSetup });
    expect(fixture.opened().prepared).not.toHaveProperty('bakedSetup');
    expect(await advanceManagedMachinePresetPreparationOperationV1({ ...request, composeBuild: async () => ({ input: buildInput, bakedSetup: retrySetup }) })).toMatchObject({ kind: 'ready',
      prepared: { artifact, bakedSetup } });
    expect(fixture.opened().prepared).not.toHaveProperty('buildSetup');
  });

  it('publishes no private revision for unchanged native observations and publishes the eventual ready artifact', async () => {
    const fixture = storageFixture();
    let ready = false;
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' as const },
      storage: fixture.storage, native: nativeFixture({ build: async () => ({ kind: 'pending', nativeOperationRef }),
        inspect: async () => ready ? { kind: 'ready', artifact } : { kind: 'pending', nativeOperationRef } }) };
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'pending' });
    expect(fixture.writes).toHaveLength(2);
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'pending' });
    expect(fixture.writes).toHaveLength(2);
    ready = true;
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'ready', prepared: { artifact } });
    expect(fixture.writes).toHaveLength(3);
    expect(readManagedMachinePresetPreparationV1({ content: fixture.opened(), ...identity }))
      .toEqual({ kind: 'warm', artifact, binaryPath: buildInput.cli.binaryPath });
  });

  it('keeps cancellation unconfirmed until the same destroy role establishes absence', async () => {
    const fixture = storageFixture();
    const native = nativeFixture({ build: async () => ({ kind: 'pending', nativeOperationRef }) });
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' as const }, storage: fixture.storage, native };
    await advanceManagedMachinePresetPreparationOperationV1(request);
    let destroys = 0;
    const cleanup = nativeFixture({ destroy: async input => {
      expect(input).toEqual({ nativeOperation: nativeOperationRef });
      destroys++;
      return destroys === 1 ? { kind: 'unknown', code: 'outcome_unknown', nativeOperationRef } : { kind: 'confirmed' };
    } });
    expect(await cancelManagedMachinePresetPreparationOperationV1({ ...request, native: cleanup }))
      .toMatchObject({ kind: 'unknown', prepared: { status: 'cancelled', nativeOperationRef } });
    expect(readManagedMachinePresetPreparationV1({ content: fixture.opened(), ...identity }))
      .toEqual({ kind: 'cold', reason: 'cancelled' });
    expect(await cancelManagedMachinePresetPreparationOperationV1({ ...request, native: cleanup }))
      .toMatchObject({ kind: 'cancelled', prepared: { status: 'cancelled' } });
    expect(fixture.opened().prepared).not.toHaveProperty('nativeOperationRef');
    expect(destroys).toBe(2);
  });

  it('preserves the encrypted envelope and recipient keys through build and owned cleanup', async () => {
    let nonce = 10;
    const custody = { mode: 'e2ee' as const, accountId: 'owner',
      accountKey: deriveBoxSecretKeyFromSeed(new Uint8Array(32).fill(71)),
      randomBytes: (length: number) => new Uint8Array(length).fill(nonce++) };
    const fixture = storageFixture(custody);
    const recipients = fixture.row().recipients;
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), custody,
      storage: fixture.storage, native: nativeFixture() };
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'ready' });
    expect(fixture.opened().prepared?.artifact).toEqual(artifact);
    expect(fixture.row().recipients).toEqual(recipients);
    expect(JSON.stringify(fixture.writes)).not.toContain('owned-image');
    expect(fixture.writes.every(row => row.content.t === 'encrypted')).toBe(true);
    expect(await cancelManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'cancelled' });
    expect(fixture.opened().prepared).not.toHaveProperty('artifact');
    expect(fixture.row().recipients).toEqual(recipients);
  });

  it('does not dispatch a native build when the initial private CAS conflicts', async () => {
    const fixture = storageFixture();
    let builds = 0;
    const result = await advanceManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one', ...identity,
      composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' }, storage: { ...fixture.storage,
        compareAndSwap: async () => ({ kind: 'conflict', currentRevision: 2 }) },
      native: nativeFixture({ build: async () => { builds++; return { kind: 'ready', artifact }; } }) });
    expect(result).toEqual({ kind: 'conflict', currentRevision: 2 });
    expect(fixture.opened().prepared).toBeUndefined();
    expect(builds).toBe(0);
  });

  it('uses the original admitted revision for the first effect CAS and current revisions for the incumbent', async () => {
    const fixture = storageFixture();
    let builds = 0;
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' as const },
      storage: fixture.storage, native: nativeFixture({ build: async () => { builds++; return { kind: 'pending', nativeOperationRef }; } }) };
    expect(await advanceManagedMachinePresetPreparationOperationV1({ ...request, expectedRevision: 2 }))
      .toEqual({ kind: 'conflict', currentRevision: 1 });
    expect(fixture.opened().prepared).toBeUndefined();
    expect(builds).toBe(0);
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'pending', revision: 3 });
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'ready', revision: 4 });
    expect(builds).toBe(1);
  });

  it('recovers a lost native response with the original provider and credential selection across author edits', async () => {
    const originalLaunch = { ...definition.launch!, credentials: [{
      purpose: { consumer: definition.launch!.provider, purpose: 'compute' },
      account: { service: { pluginId: 'fixture.compute', localId: 'auth' }, accountId: 'original-account' },
    }] };
    const { name: _originalName, ...originalBindingLaunch } = originalLaunch;
    const fixture = storageFixture(undefined, { ...definition, launch: originalLaunch });
    const roots: ManagedMachinePresetPreparationRootV1[] = [];
    let builds = 0;
    let compositions = 0;
    const request = { operationId: 'operation-one', ...identity,
      composeBuild: async () => { compositions++; return { input: buildInput }; }, credentialConfigurations: [], custody: { mode: 'plain' as const },
      storage: fixture.storage, native: nativeFixture({ build: async (_input, root) => {
        roots.push(root); builds++; throw new Error('transport lost');
      }, inspect: async (input, root) => {
          roots.push(root);
          expect(input).toEqual({ operationId: 'operation-one', launch: buildInput.launch.choices });
          return { kind: 'ready', artifact };
        }, destroy: async (_input, root) => { roots.push(root); return { kind: 'confirmed' }; } }) };
    await expect(advanceManagedMachinePresetPreparationOperationV1(request)).rejects.toThrow('transport lost');
    const edited = replaceManagedMachinePresetAuthorContentV1({ presetId: 'preset', mode: 'plain',
      projection: projectManagedMachinePresetForRecipientV1({ ...fixture.row(), recipientAccountId: 'owner' }),
      content: { ...definition, launch: { ...originalLaunch,
        provider: { pluginId: 'different.compute', localId: 'different-vm' }, schemaVersion: 2,
        choices: { image: 'new-current-base' }, credentials: [{ ...originalLaunch.credentials[0]!,
          account: { ...originalLaunch.credentials[0]!.account, accountId: 'new-account' } }] } } });
    expect(edited).not.toBeNull();
    await fixture.storage.compareAndSwap({ expectedRevision: fixture.row().revision,
      content: edited!.content, recipients: [...edited!.recipients] });
    const { composeBuild: _unavailableBuildComposition, ...reloaded } = request;
    expect(await advanceManagedMachinePresetPreparationOperationV1({ ...reloaded, operationId: 'operation-two' }))
      .toEqual({ kind: 'conflict', currentRevision: 3 });
    expect(await advanceManagedMachinePresetPreparationOperationV1(reloaded)).toMatchObject({ kind: 'ready',
      prepared: { operationId: 'operation-one', status: 'ready', artifact } });
    expect(await cancelManagedMachinePresetPreparationOperationV1(reloaded)).toMatchObject({ kind: 'cancelled' });
    expect(builds).toBe(1);
    expect(compositions).toBe(1);
    expect(roots).toHaveLength(3);
    for (const root of roots) expect(root).toMatchObject({ launch: originalBindingLaunch });
  });

  it('recovers an unreferenced build during cancellation and destroys its recovered native operation', async () => {
    const fixture = storageFixture();
    let builds = 0;
    let compositions = 0;
    const request = { operationId: 'operation-one', ...identity,
      composeBuild: async () => { compositions++; return { input: { ...buildInput, setupScript: 'original-clean-input' } }; },
      credentialConfigurations: [], custody: { mode: 'plain' as const },
      storage: fixture.storage, native: nativeFixture({ build: async () => { builds++; throw new Error('transport lost'); },
        inspect: async input => {
          expect(input).toEqual({ operationId: 'operation-one', launch: buildInput.launch.choices });
          return { kind: 'pending', nativeOperationRef };
        }, destroy: async input => {
          expect(input).toEqual({ nativeOperation: nativeOperationRef });
          return { kind: 'confirmed' };
        } }) };
    await expect(advanceManagedMachinePresetPreparationOperationV1(request)).rejects.toThrow('transport lost');
    const { composeBuild: _unavailableBuildComposition, ...reloaded } = request;
    expect(await cancelManagedMachinePresetPreparationOperationV1(reloaded)).toMatchObject({ kind: 'cancelled' });
    expect(fixture.opened().prepared).not.toHaveProperty('nativeOperationRef');
    expect(builds).toBe(1);
    expect(compositions).toBe(1);
  });

  it.each([{ kind: 'conflict', currentRevision: 3 }, { kind: 'refused', code: 'permission_denied' }] as const)(
    'passes saved root facts and retains cleanup refs when the outcome write is $kind', async failure => {
    const fixture = storageFixture();
    const storage: ManagedMachinePresetPreparationStorageV1 = { ...fixture.storage,
      compareAndSwap: async replacement => fixture.writes.length === 0
        ? fixture.storage.compareAndSwap(replacement) : failure };
    const result = await advanceManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one', ...identity,
      composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' }, storage,
      native: nativeFixture({ build: async (_input, facts) => {
        expect(facts).toEqual({ presetId: 'preset', presetRevision: 2, operationId: 'operation-one',
          launch: buildInput.launch });
        return { kind: 'pending', nativeOperationRef };
      } }) });
    expect(result).toEqual({ ...failure,
      recovery: { operationId: 'operation-one', nativeOperationRef } });
    expect(fixture.opened().prepared).not.toHaveProperty('nativeOperationRef');
  });

  it('admits a replacement operation only after the old native ownership is confirmed absent', async () => {
    const fixture = storageFixture();
    let builds = 0;
    const native = nativeFixture({ build: async () => { builds++; return { kind: 'ready', artifact }; } });
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' as const },
      storage: fixture.storage, native };
    await advanceManagedMachinePresetPreparationOperationV1(request);
    const replacement = { ...request, operationId: 'operation-two' };
    expect(await advanceManagedMachinePresetPreparationOperationV1(replacement)).toMatchObject({ kind: 'conflict' });
    await cancelManagedMachinePresetPreparationOperationV1({ ...request,
      native: nativeFixture({ destroy: async () => ({ kind: 'unknown', code: 'outcome_unknown', nativeOperationRef }) }) });
    expect(await advanceManagedMachinePresetPreparationOperationV1(replacement)).toMatchObject({ kind: 'conflict' });
    expect(builds).toBe(1);
    await cancelManagedMachinePresetPreparationOperationV1(request);
    expect(await advanceManagedMachinePresetPreparationOperationV1({ ...replacement, expectedRevision: fixture.row().revision })).toMatchObject({ kind: 'ready',
      prepared: { operationId: 'operation-two', artifact } });
    expect(builds).toBe(2);
  });

  it.each(['pending', 'unknown'] as const)('replacement follows %s old cleanup before composing the captured new configuration', async kind => {
    vi.useFakeTimers();
    try {
      const oldLaunch = { ...definition.launch!, credentials: [{
        purpose: { consumer: definition.launch!.provider, purpose: 'compute' },
        account: { service: { pluginId: 'fixture.compute', localId: 'auth' }, accountId: 'old-account' },
      }] };
      const fixture = storageFixture(undefined, { ...definition, launch: oldLaunch });
      await advanceManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one', ...identity,
        composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' }, storage: fixture.storage, native: nativeFixture() });
      const target = { ...definition, launch: { ...oldLaunch, provider: { pluginId: 'new.compute', localId: 'image' },
        schemaVersion: 2, choices: { image: 'target-before-cleanup' }, credentials: [{ ...oldLaunch.credentials[0]!,
          account: { ...oldLaunch.credentials[0]!.account, accountId: 'new-account' } }] },
        setup: { scripts: [{ body: 'target-before-cleanup' }] } };
      await editAuthor(fixture, target);
      const replacementArtifact = { contributionRef: target.launch.provider, schemaVersion: 2, value: { image: 'replacement-owned' } };
      const events: string[] = [];
      const { name: _oldName, ...oldBindingLaunch } = oldLaunch;
      const { name: _targetName, ...targetBindingLaunch } = target.launch;
      let destroys = 0;
      let settled = false;
      const settling = settleManagedMachinePresetPreparationOperationV1({ operationId: 'operation-two',
        expectedRevision: fixture.row().revision, credentialConfigurations: [], custody: { mode: 'plain' }, storage: fixture.storage,
        composeBuild: async (captured: ManagedMachinePresetContentV1) => {
          events.push('compose');
          expect(captured).toMatchObject({ launch: target.launch, setup: target.setup });
          if (!captured?.launch) throw new Error('A replacement requires its captured launch');
          const { provider, schemaVersion, choices } = captured.launch;
          return { input: { ...buildInput, launch: { provider, schemaVersion, choices } }, bakedSetup: captured.setup };
        }, native: nativeFixture({ destroy: async (_input, root) => {
          events.push('destroy');
          expect(root).toMatchObject({ operationId: 'operation-one', launch: oldBindingLaunch });
          return ++destroys === 1 ? kind === 'unknown' ? { kind, code: 'outcome_unknown', nativeOperationRef } : { kind, nativeOperationRef }
            : { kind: 'confirmed' };
        }, build: async (input, root) => {
          events.push('build');
          expect(input.input).toEqual({ ...buildInput,
            launch: { provider: target.launch.provider, schemaVersion: 2, choices: target.launch.choices } });
          expect(root).toMatchObject({ operationId: 'operation-two', launch: targetBindingLaunch });
          return { kind: 'ready', artifact: replacementArtifact };
        } }) }).then(result => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(events).toEqual(['destroy']);
      const editedDuringCleanup = { ...target, launch: { ...target.launch, choices: { image: 'later-author-edit' } },
        setup: { scripts: [{ body: 'later-author-edit' }] } };
      await editAuthor(fixture, editedDuringCleanup);
      await vi.advanceTimersToNextTimerAsync();
      expect(await settling).toMatchObject({ kind: 'ready', prepared: { operationId: 'operation-two', artifact: replacementArtifact,
        bakedSetup: target.setup, binding: { configuration: { launch: targetBindingLaunch, setup: target.setup } } } });
      expect(fixture.opened().launch).toEqual(editedDuringCleanup.launch);
      expect(events).toEqual(['destroy', 'destroy', 'compose', 'build']);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('replacement rejects a stale initial revision before destroying the incumbent', async () => {
    const fixture = storageFixture();
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }),
      credentialConfigurations: [], custody: { mode: 'plain' as const }, storage: fixture.storage, native: nativeFixture() };
    await advanceManagedMachinePresetPreparationOperationV1(request);
    let effects = 0;
    expect(await settleManagedMachinePresetPreparationOperationV1({ ...request, operationId: 'operation-two',
      composeBuild: async () => { effects++; return { input: buildInput }; },
      native: nativeFixture({ destroy: async () => { effects++; return { kind: 'confirmed' }; } }) }))
      .toMatchObject({ kind: 'conflict', currentRevision: fixture.row().revision });
    expect(effects).toBe(0);
    expect(fixture.opened().prepared).toMatchObject({ status: 'ready', artifact });
  });

  // O-MACH 2026-11-16 07:18: Retry is a new admission inspecting retained
  // native identity; executor correlation/retirement is not part of this flow.
  it.each(['matching', 'cli-changed', 'cli-changed-auto-rebuild', 'config-changed', 'credential-changed'] as const)('new admission inspects interrupted build before %s recovery', async scenario => {
    const fixture = storageFixture({ mode: 'plain' }, scenario === 'cli-changed-auto-rebuild'
      ? { ...definition, preparation: { enabled: true, whenHappierUpdates: 'rebuild-automatically' } } : definition);
    await advanceManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one', ...identity,
      composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' }, storage: fixture.storage,
      native: nativeFixture({ build: async () => ({ kind: 'pending', nativeOperationRef }) }) });
    if (scenario === 'config-changed') await editAuthor(fixture, { ...definition,
      launch: { ...definition.launch!, choices: { image: 'new-target' } } });
    const events: string[] = [];
    const cliIdentity = scenario === 'cli-changed' || scenario === 'cli-changed-auto-rebuild' ? 'new-cli-identity' : buildInput.cli.identity;
    const credentialConfigurations = scenario === 'credential-changed' ? [{
      account: { service: { pluginId: 'fixture.compute', localId: 'auth' }, accountId: 'account' }, revision: 'new-configuration',
    }] : [];
    const outcome = await settleManagedMachinePresetPreparationOperationV1({ operationId: 'operation-two',
      expectedRevision: fixture.row().revision, cliIdentity, credentialConfigurations, custody: { mode: 'plain' }, storage: fixture.storage,
      composeBuild: async captured => { events.push('compose'); return { input: { ...buildInput,
        cli: { ...buildInput.cli, identity: cliIdentity }, launch: { ...buildInput.launch, choices: captured.launch!.choices } } }; },
      native: nativeFixture({ inspect: async (input, root) => {
        events.push('inspect');
        expect(input).toEqual({ nativeOperation: nativeOperationRef });
        expect(root.operationId).toBe('operation-one');
        return { kind: 'ready', artifact };
      }, destroy: async () => { events.push('destroy'); return { kind: 'confirmed' }; },
        build: async () => { events.push('build'); return { kind: 'ready', artifact }; } }) });
    const reusable = scenario === 'matching' || scenario === 'cli-changed';
    expect(outcome).toMatchObject({ kind: 'ready', prepared: { operationId: reusable ? 'operation-one' : 'operation-two' } });
    expect(events).toEqual(reusable ? ['inspect'] : ['inspect', 'destroy', 'compose', 'build']);
    expect(fixture.opened().prepared?.binding.credentialConfigurations).toEqual(credentialConfigurations);
  });

  it('interrupted recovery follows unknown inspection without a second build and Stop cleans original identity', async () => {
    vi.useFakeTimers();
    try {
      const fixture = storageFixture();
      const original = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }),
        credentialConfigurations: [], custody: { mode: 'plain' as const }, storage: fixture.storage, native: nativeFixture({ build: async () => { throw new Error('response lost'); } }) };
      await expect(advanceManagedMachinePresetPreparationOperationV1(original)).rejects.toThrow('response lost');
      const stop = new AbortController();
      const events: string[] = [];
      const recovering = settleManagedMachinePresetPreparationOperationV1({ ...original, operationId: 'operation-two',
        expectedRevision: fixture.row().revision, signal: stop.signal, cliIdentity: buildInput.cli.identity,
        composeBuild: async () => { events.push('compose'); return { input: buildInput }; }, native: nativeFixture({
          inspect: async input => { events.push('inspect'); expect(input).toEqual({ operationId: 'operation-one', launch: buildInput.launch.choices });
            return { kind: 'unknown', code: 'outcome_unknown', nativeOperationRef }; },
          destroy: async (_input, root) => { events.push('destroy'); expect(root.operationId).toBe('operation-one'); return { kind: 'confirmed' }; },
          build: async () => { events.push('build'); return { kind: 'ready', artifact }; },
        }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(['inspect']);
      stop.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(await recovering).toMatchObject({ kind: 'cancelled', prepared: { operationId: 'operation-one' } });
      expect(events).toEqual(['inspect', 'destroy']);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('stale new admission cannot inspect an interrupted original operation', async () => {
    const fixture = storageFixture();
    await advanceManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one', ...identity,
      composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' }, storage: fixture.storage,
      native: nativeFixture({ build: async () => ({ kind: 'pending', nativeOperationRef }) }) });
    let effects = 0;
    expect(await settleManagedMachinePresetPreparationOperationV1({ operationId: 'operation-two', expectedRevision: 1,
      credentialConfigurations: [], custody: { mode: 'plain' }, storage: fixture.storage, native: nativeFixture({ inspect: async () => {
        effects++; return { kind: 'ready', artifact }; } }) })).toMatchObject({ kind: 'conflict' });
    expect(effects).toBe(0);
  });

  it('replacement conflicts before composition when a newer admitted operation retired its own binding', async () => {
    const fixture = storageFixture();
    const baseRequest = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }),
      credentialConfigurations: [], custody: { mode: 'plain' as const }, storage: fixture.storage, native: nativeFixture() };
    await advanceManagedMachinePresetPreparationOperationV1(baseRequest);
    const storage: ManagedMachinePresetPreparationStorageV1 = { ...fixture.storage,
      compareAndSwap: async replacement => {
        const saved = await fixture.storage.compareAndSwap(replacement);
        const current = fixture.opened().prepared;
        if (saved.kind === 'saved' && current?.operationId === 'operation-one' && current.status === 'cancelled'
          && !current.artifact && !current.nativeOperationRef) {
          const newer = { ...baseRequest, operationId: 'operation-newer', expectedRevision: fixture.row().revision,
            native: nativeFixture({ build: async () => ({ kind: 'refused', code: 'invalid_request' }) }) };
          expect(await advanceManagedMachinePresetPreparationOperationV1(newer)).toMatchObject({ kind: 'failed' });
          expect(await cancelManagedMachinePresetPreparationOperationV1(newer)).toMatchObject({ kind: 'cancelled' });
        }
        return saved;
      } };
    let newEffects = 0;
    expect(await settleManagedMachinePresetPreparationOperationV1({ ...baseRequest, storage,
      operationId: 'operation-replacement', expectedRevision: fixture.row().revision,
      composeBuild: async () => { newEffects++; return { input: buildInput }; },
      native: nativeFixture({ build: async () => { newEffects++; return { kind: 'ready', artifact }; } }) }))
      .toMatchObject({ kind: 'conflict', currentRevision: fixture.row().revision });
    expect(newEffects).toBe(0);
    expect(fixture.opened().prepared).toMatchObject({ operationId: 'operation-newer', status: 'cancelled' });
  });

  it('Stop during replacement cleanup confirms old absence and prevents new composition', async () => {
    vi.useFakeTimers();
    try {
      const fixture = storageFixture();
      await advanceManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one', ...identity,
        composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' }, storage: fixture.storage, native: nativeFixture() });
      const stop = new AbortController();
      let destroys = 0;
      let newEffects = 0;
      const settling = settleManagedMachinePresetPreparationOperationV1({ operationId: 'operation-two',
        expectedRevision: fixture.row().revision, signal: stop.signal, credentialConfigurations: [], custody: { mode: 'plain' }, storage: fixture.storage,
        composeBuild: async () => { newEffects++; return { input: buildInput }; }, native: nativeFixture({
          destroy: async () => ++destroys === 1 ? { kind: 'unknown', code: 'outcome_unknown', nativeOperationRef } : { kind: 'confirmed' },
          build: async () => { newEffects++; return { kind: 'ready', artifact }; },
        }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.opened().prepared).toMatchObject({ status: 'cancelled', artifact });
      stop.abort();
      await vi.advanceTimersToNextTimerAsync();
      expect(await settling).toMatchObject({ kind: 'cancelled', prepared: { operationId: 'operation-one' } });
      expect(fixture.opened().prepared).not.toHaveProperty('artifact');
      expect(fixture.opened().prepared).not.toHaveProperty('nativeOperationRef');
      expect(newEffects).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])('Stop during composition respects newer retired binding=%s ownership', async newerBinding => {
    const fixture = storageFixture();
    await advanceManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one', ...identity,
      composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' }, storage: fixture.storage, native: nativeFixture() });
    const stop = new AbortController();
    let releaseComposition!: () => void;
    let compositionStarted!: () => void;
    const started = new Promise<void>(resolve => { compositionStarted = resolve; });
    const composition = new Promise<void>(resolve => { releaseComposition = resolve; });
    let builds = 0;
    const settling = settleManagedMachinePresetPreparationOperationV1({ operationId: 'operation-two',
      expectedRevision: fixture.row().revision, signal: stop.signal, credentialConfigurations: [], custody: { mode: 'plain' }, storage: fixture.storage,
      composeBuild: async () => { compositionStarted(); await composition; return { input: buildInput }; },
      native: nativeFixture({ build: async () => { builds++; return { kind: 'ready', artifact }; } }) });
    const outcome = await Promise.race([started.then(() => 'composing'), settling.then(() => 'settled')]);
    expect(outcome).toBe('composing');
    if (newerBinding) {
      const newer = { operationId: 'operation-newer', expectedRevision: fixture.row().revision,
        composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' as const }, storage: fixture.storage,
        native: nativeFixture({ build: async () => ({ kind: 'refused', code: 'invalid_request' }) }) };
      expect(await advanceManagedMachinePresetPreparationOperationV1(newer)).toMatchObject({ kind: 'failed' });
      expect(await cancelManagedMachinePresetPreparationOperationV1(newer)).toMatchObject({ kind: 'cancelled' });
    }
    stop.abort();
    releaseComposition();
    expect(await settling).toMatchObject(newerBinding ? { kind: 'conflict', currentRevision: fixture.row().revision }
      : { kind: 'cancelled', prepared: { operationId: 'operation-one' } });
    expect(fixture.opened().prepared).toMatchObject({ operationId: newerBinding ? 'operation-newer' : 'operation-one', status: 'cancelled' });
    expect(builds).toBe(0);
  });

  it('allows retry after a definite build refusal without inventing native ownership to destroy', async () => {
    const fixture = storageFixture();
    let destroys = 0;
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), credentialConfigurations: [], custody: { mode: 'plain' as const },
      storage: fixture.storage, native: nativeFixture({ build: async () => ({ kind: 'refused', code: 'invalid_request' }),
        destroy: async () => { destroys++; return { kind: 'confirmed' }; } }) };
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'failed' });
    expect(await cancelManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'cancelled',
      prepared: { operationId: 'operation-one', status: 'cancelled' } });
    expect(destroys).toBe(0);
    expect(await advanceManagedMachinePresetPreparationOperationV1({ ...request, operationId: 'operation-two',
      expectedRevision: fixture.row().revision, native: nativeFixture() }))
      .toMatchObject({ kind: 'ready', prepared: { operationId: 'operation-two' } });
  });
});

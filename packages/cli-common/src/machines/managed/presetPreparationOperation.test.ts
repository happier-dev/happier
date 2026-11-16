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
import { readManagedMachinePresetPreparationV1 } from './presetPreparation.js';
import { advanceManagedMachinePresetPreparationOperationV1, cancelManagedMachinePresetPreparationOperationV1,
  settleManagedMachinePresetPreparationOperationV1,
  type ManagedMachinePresetPreparationCustodyV1, type ManagedMachinePresetPreparationStorageV1,
  type ManagedMachinePresetPreparationNativeV1, type ManagedMachinePresetPreparationRootV1 } from './presetPreparationOperation.js';

const definition: ManagedMachinePresetContentV1 = { v: 1, name: 'Private preset', preparation: { enabled: true },
  launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1,
    name: 'Guest', choices: { image: 'clean-base' } } };
const artifact = { contributionRef: definition.launch!.provider, schemaVersion: 1, value: { image: 'owned-image' } };
const nativeOperationRef = { ...artifact, value: { name: 'build-operation-one' } };
const identity = { expectedRevision: 1, cliIdentity: `home-payload:${'a'.repeat(64)}` };
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
  content: ManagedMachinePresetContentV1 = definition) {
  const seed = new Uint8Array(32).fill(71);
  const publicKey = deriveBoxPublicKeyFromSeed(seed);
  const sealed = custody.mode === 'plain' ? { content: { t: 'plain', v: content }, recipients: [] }
    : sealManagedMachinePresetContentV1({ presetId: 'preset', ...custody, content,
      recipientCensus: [SavedSecretResourceEnvelopeCensusRecipientV1Schema.parse({
        account: { kind: 'account', accountId: 'owner', name: 'Owner', firstName: 'Owner', lastName: null, username: null, avatarUrl: null },
        readiness: { status: 'available', contentPublicKey: encodeBase64(publicKey, 'base64'),
          contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) }, envelopeStatus: 'missing',
      })] });
  let row = ManagedMachinePresetV1Schema.parse({ id: 'preset', homeId: 'home', revision: 1,
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
    expect(readManagedMachinePresetPreparationV1({ content: fixture.opened(), presetRevision: fixture.row().revision, ...identity }))
      .toEqual({ kind: 'cold', reason: 'building' });
    expect(await advanceManagedMachinePresetPreparationOperationV1({ ...request,
      composeBuild: async () => ({ input: { ...buildInput, cli: { ...buildInput.cli, binaryPath: '/different-current-cli/happier' } },
        bakedSetup: { scripts: [{ body: 'unrelated-retry-setup', affects: 'none' }] } }) }))
      .toMatchObject({ kind: 'ready', prepared: { cliBinaryPath: buildInput.cli.binaryPath } });
    expect(fixture.opened().prepared).not.toHaveProperty('bakedSetup');
    expect(readManagedMachinePresetPreparationV1({ content: fixture.opened(), presetRevision: fixture.row().revision, ...identity }))
      .toMatchObject({ kind: 'warm', binaryPath: buildInput.cli.binaryPath });
  });
  it('foreground following retains the operation until native readiness and leaves no settled timer', async () => {
    vi.useFakeTimers();
    try {
      const fixture = storageFixture();
      let inspections = 0;
      const settling = settleManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one', ...identity,
        composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' }, storage: fixture.storage,
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
        composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' }, storage: fixture.storage, signal: stop.signal,
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

  it.each(['artifact', 'nativeOperation'] as const)('reload follows retained cancelled %s cleanup through confirmed absence', async reference => {
    vi.useFakeTimers();
    try {
      const fixture = storageFixture();
      let destroys = 0;
      let builds = 0;
      const request = { operationId: 'operation-one', ...identity,
        composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' as const }, storage: fixture.storage,
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
        binding: { presetRevision: fixture.row().revision } });
      return { kind: 'ready', artifact };
    } });
    const result = await advanceManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one',
      ...identity, composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' }, storage: fixture.storage, native });
    expect(result).toMatchObject({ kind: 'ready', revision: 3, prepared: { operationId: 'operation-one', artifact } });
    expect(fixture.writes.map(row => row.revision)).toEqual([2, 3]);
    expect(readManagedMachinePresetPreparationV1({ content: fixture.opened(), presetRevision: fixture.row().revision, ...identity }))
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
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' as const }, storage: fixture.storage, native };
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
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' as const },
      storage: fixture.storage, native: nativeFixture({ build: async () => ({ kind: 'pending', nativeOperationRef }),
        inspect: async () => ready ? { kind: 'ready', artifact } : { kind: 'pending', nativeOperationRef } }) };
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'pending' });
    expect(fixture.writes).toHaveLength(2);
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'pending' });
    expect(fixture.writes).toHaveLength(2);
    ready = true;
    expect(await advanceManagedMachinePresetPreparationOperationV1(request)).toMatchObject({ kind: 'ready', prepared: { artifact } });
    expect(fixture.writes).toHaveLength(3);
    expect(readManagedMachinePresetPreparationV1({ content: fixture.opened(), presetRevision: fixture.row().revision, ...identity }))
      .toEqual({ kind: 'warm', artifact, binaryPath: buildInput.cli.binaryPath });
  });

  it('keeps cancellation unconfirmed until the same destroy role establishes absence', async () => {
    const fixture = storageFixture();
    const native = nativeFixture({ build: async () => ({ kind: 'pending', nativeOperationRef }) });
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' as const }, storage: fixture.storage, native };
    await advanceManagedMachinePresetPreparationOperationV1(request);
    let destroys = 0;
    const cleanup = nativeFixture({ destroy: async input => {
      expect(input).toEqual({ nativeOperation: nativeOperationRef });
      destroys++;
      return destroys === 1 ? { kind: 'unknown', code: 'outcome_unknown', nativeOperationRef } : { kind: 'confirmed' };
    } });
    expect(await cancelManagedMachinePresetPreparationOperationV1({ ...request, native: cleanup }))
      .toMatchObject({ kind: 'unknown', prepared: { status: 'cancelled', nativeOperationRef } });
    expect(readManagedMachinePresetPreparationV1({ content: fixture.opened(), presetRevision: fixture.row().revision, ...identity }))
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
      composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' }, storage: { ...fixture.storage,
        compareAndSwap: async () => ({ kind: 'conflict', currentRevision: 2 }) },
      native: nativeFixture({ build: async () => { builds++; return { kind: 'ready', artifact }; } }) });
    expect(result).toEqual({ kind: 'conflict', currentRevision: 2 });
    expect(fixture.opened().prepared).toBeUndefined();
    expect(builds).toBe(0);
  });

  it('uses the original admitted revision for the first effect CAS and current revisions for the incumbent', async () => {
    const fixture = storageFixture();
    let builds = 0;
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' as const },
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
      composeBuild: async () => { compositions++; return { input: buildInput }; }, custody: { mode: 'plain' as const },
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
      custody: { mode: 'plain' as const },
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
      composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' }, storage,
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
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' as const },
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
        composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' }, storage: fixture.storage, native: nativeFixture() });
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
        expectedRevision: fixture.row().revision, custody: { mode: 'plain' }, storage: fixture.storage,
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
          expect(input.input.launch).toEqual({ provider: target.launch.provider, schemaVersion: 2, choices: target.launch.choices });
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
      custody: { mode: 'plain' as const }, storage: fixture.storage, native: nativeFixture() };
    await advanceManagedMachinePresetPreparationOperationV1(request);
    let effects = 0;
    expect(await settleManagedMachinePresetPreparationOperationV1({ ...request, operationId: 'operation-two',
      composeBuild: async () => { effects++; return { input: buildInput }; },
      native: nativeFixture({ destroy: async () => { effects++; return { kind: 'confirmed' }; } }) }))
      .toMatchObject({ kind: 'conflict', currentRevision: fixture.row().revision });
    expect(effects).toBe(0);
    expect(fixture.opened().prepared).toMatchObject({ status: 'ready', artifact });
  });

  it('replacement preserves an active incumbent paused before provider create despite native absence', async () => {
    const fixture = storageFixture();
    let releaseCreate!: () => void;
    let buildStarted!: () => void;
    const started = new Promise<void>(resolve => { buildStarted = resolve; });
    const upload = new Promise<void>(resolve => { releaseCreate = resolve; });
    let created = false;
    const original = advanceManagedMachinePresetPreparationOperationV1({ operationId: 'operation-one', ...identity,
      composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' }, storage: fixture.storage,
      native: nativeFixture({ build: async () => {
        buildStarted();
        await upload;
        created = true;
        return { kind: 'ready', artifact };
      } }) });
    await started;
    let replacementEffects = 0;
    const replacementArtifact = { ...artifact, value: { image: 'replacement-owned' } };
    const replacement = await settleManagedMachinePresetPreparationOperationV1({ operationId: 'operation-two',
      expectedRevision: fixture.row().revision, custody: { mode: 'plain' }, storage: fixture.storage,
      composeBuild: async () => { replacementEffects++; return { input: buildInput }; },
      native: nativeFixture({ inspect: async () => {
        replacementEffects++;
        expect(created).toBe(false);
        return { kind: 'absent' };
      }, build: async () => { replacementEffects++; return { kind: 'ready', artifact: replacementArtifact }; } }) });
    releaseCreate();
    const originalOutcome = await original;
    expect.soft(replacement).toMatchObject({ kind: 'conflict' });
    expect.soft(originalOutcome).toMatchObject({ kind: 'ready', prepared: { operationId: 'operation-one', artifact } });
    expect.soft(fixture.opened().prepared).toMatchObject({ operationId: 'operation-one', status: 'ready', artifact });
    expect.soft(replacementEffects).toBe(0);
  });

  it('replacement conflicts before composition when a newer admitted operation retired its own binding', async () => {
    const fixture = storageFixture();
    const baseRequest = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }),
      custody: { mode: 'plain' as const }, storage: fixture.storage, native: nativeFixture() };
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
        composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' }, storage: fixture.storage, native: nativeFixture() });
      const stop = new AbortController();
      let destroys = 0;
      let newEffects = 0;
      const settling = settleManagedMachinePresetPreparationOperationV1({ operationId: 'operation-two',
        expectedRevision: fixture.row().revision, signal: stop.signal, custody: { mode: 'plain' }, storage: fixture.storage,
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
      composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' }, storage: fixture.storage, native: nativeFixture() });
    const stop = new AbortController();
    let releaseComposition!: () => void;
    let compositionStarted!: () => void;
    const started = new Promise<void>(resolve => { compositionStarted = resolve; });
    const composition = new Promise<void>(resolve => { releaseComposition = resolve; });
    let builds = 0;
    const settling = settleManagedMachinePresetPreparationOperationV1({ operationId: 'operation-two',
      expectedRevision: fixture.row().revision, signal: stop.signal, custody: { mode: 'plain' }, storage: fixture.storage,
      composeBuild: async () => { compositionStarted(); await composition; return { input: buildInput }; },
      native: nativeFixture({ build: async () => { builds++; return { kind: 'ready', artifact }; } }) });
    const outcome = await Promise.race([started.then(() => 'composing'), settling.then(() => 'settled')]);
    expect(outcome).toBe('composing');
    if (newerBinding) {
      const newer = { operationId: 'operation-newer', expectedRevision: fixture.row().revision,
        composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' as const }, storage: fixture.storage,
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
    const request = { operationId: 'operation-one', ...identity, composeBuild: async () => ({ input: buildInput }), custody: { mode: 'plain' as const },
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

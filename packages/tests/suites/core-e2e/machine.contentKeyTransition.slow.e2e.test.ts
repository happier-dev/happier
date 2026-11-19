import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { MachineAccessMutationResultV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { decodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { ApiClient } from '../../../../apps/cli/src/api/api';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '../../../../apps/cli/src/api/clientCompatibility/cliClientCompatibility';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../../../../apps/cli/src/api/encryption';
import { createRunDirs } from '../../src/testkit/runDir';
import { buildTestAccountCliAuthCredentials } from '../../src/testkit/cliAuth';
import { startTeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { fetchJson } from '../../src/testkit/http';
import { addFriend, setUsername } from '../../src/testkit/socialFriends';
import { createUserScopedSocketCollector, type SocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';
import { buildMachineInstallationProof, createMachineInstallationIdentityFixture } from '../../src/testkit/machineIdentity';

const run = createRunDirs({ runLabel: 'core' });

describe('composed Machine content-key conversion', () => {
  it('preserves concurrent predecessor edits atomically, refuses present broken envelopes, and follows persisted Account mode', async () => {
    const testDir = run.testDir('machine-content-key-conversion');
    const postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
    let fixture: Awaited<ReturnType<typeof startTeamSetupFFixture>> | undefined;
    let socket: SocketCollector | undefined;
    let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
    let beforeTransition: (() => Promise<void>) | undefined;
    try {
      fixture = await startTeamSetupFFixture({ testDir, dbProvider: 'postgres', guestReachableHome: { host: '127.0.0.1' },
        beforeHttpRequest: async request => {
          if (request.method === 'POST' && request.path.endsWith('/content-key/transition')) await beforeTransition?.();
        }, serverEnv: {
        DATABASE_URL: postgres.homeDatabaseUrl, HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: '1', HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: '1',
      } });
      const account = await fixture.createAccount('content-key-owner');
      const accountId = readAccountIdFromToken(account.credentials.token);
      if (!accountId) throw new Error('Account fixture token did not identify its owner');
      const credentialMaterial = account.credentials.encryption;
      if (!credentialMaterial) throw new Error('Encrypted Account fixture did not retain its key material');
      const features = await fetchJson<unknown>(`${fixture.server.baseUrl}/v1/features/authenticated`, {
        headers: { Authorization: `Bearer ${account.auth.token}` },
      });
      const home = FeaturesResponseSchema.parse(features.data).homeConnectionDescriptor;
      if (!home || home.homeServerIdentityId !== fixture.serverId) throw new Error('Conversion Home descriptor unavailable');
      // Both direct and Action-scoped requests must reach the same observed ingress.
      ui = await connectUiActionClient({ serverUrl: home.canonicalServerUrl,
        credentials: buildTestAccountCliAuthCredentials({ auth: account.auth, mode: 'legacy' }) });
      await waitFor(() => ui!.isAccountReady(), { context: 'conversion Account ready' });
      const machine = await fixture.enrollDaemon(account);
      const machineId = machine.target.machineId;
      await writeFile(join(machine.workspaceDir, 'conversion-sentinel.txt'), 'retained daemon control');
      const assertDaemonControl = async () => {
        const result = await account.execute('daemon.filesystem.listDirectory', { rootPath: machine.workspaceDir, path: '.' }, {
          externalActionTarget: { kind: 'machine', machineId },
        });
        expect(result).toMatchObject({ ok: true, result: { success: true,
          entries: expect.arrayContaining([expect.objectContaining({ name: 'conversion-sentinel.txt' })]) } });
        const retainedUi = await ui!.executeConfirmed('daemon.filesystem.listDirectory', { rootPath: machine.workspaceDir, path: '.' }, {
          surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: ui!.serverId,
          externalActionTarget: { kind: 'machine', machineId },
        });
        expect(retainedUi).toMatchObject({ ok: true, result: { success: true,
          entries: expect.arrayContaining([expect.objectContaining({ name: 'conversion-sentinel.txt' })]) } });
      };
      await assertDaemonControl();
      const cliPreparation = await account.executeReviewed('machines.access.prepareKeys', machine.target, {
        externalActionTarget: { kind: 'machine', machineId },
      });
      expect(cliPreparation, JSON.stringify(cliPreparation)).toMatchObject({ ok: true, result: { kind: 'prepared' } });
      await machine.daemon.stop();
      const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${account.auth.token}`, 'Content-Type': 'application/json' };
      const read = async () => {
        const response = await fetchJson<{ machine: unknown }>(`${fixture!.server.baseUrl}/v1/machines/${machineId}`, { headers });
        expect(response.status).toBe(200);
        return MachinePublishedRowV1Schema.parse(response.data.machine);
      };
      const initial = await read();
      const predecessorCredentials = { ...account.credentials,
        encryption: { type: 'legacy' as const, secret: account.auth.accountSigningSeed } };
      const api = await ApiClient.create(predecessorCredentials);
      const prepareThroughAction = () => ui!.executeConfirmed('machines.access.prepareKeys', machine.target, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: ui!.serverId,
        externalActionTarget: { kind: 'machine', machineId },
      });
      // Released absent-envelope legacy content used the recovery secret.
      // Seed that exact historical representation, not a current resource key.
      const metadata = { host: 'predecessor-host', homeDir: machine.homeDir, platform: 'linux',
        happyCliVersion: 'predecessor', happyHomeDir: machine.homeDir, displayName: 'Before edit',
        legacyExtension: { preserve: 'opaque historical metadata' } };
      const daemonState = { status: 'stopped', legacyDaemonExtension: { preserve: true } };
      const encodePredecessor = (value: unknown) => encodeBase64(encrypt(account.auth.accountSigningSeed, 'legacy', value));
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const seed = async (row: Readonly<{ metadata: string; daemonState: string | null; dataEncryptionKey?: string | null;
        metadataVersion: number; daemonStateVersion: number }>) => {
        // Only this journey's stopped daemon row in its disposable Postgres is seeded.
        await postgres.sql('happier', `UPDATE "Machine" SET "metadata"=${quote(row.metadata)}, "metadataBytes"=NULL,
          "daemonState"=${row.daemonState === null ? 'NULL' : quote(row.daemonState)}, "daemonStateBytes"=NULL,
          "dataEncryptionKey"=${row.dataEncryptionKey ? `decode(${quote(row.dataEncryptionKey)}, 'base64')` : 'NULL'},
          "metadataVersion"=${row.metadataVersion}, "daemonStateVersion"=${row.daemonStateVersion}
          WHERE "id"=${quote(machineId)};`);
      };
      const readPersistedContent = async (): Promise<unknown> => JSON.parse(await postgres.sql('happier', `SELECT json_build_object(
        'metadata', "metadata", 'daemonState', "daemonState", 'dataEncryptionKey', replace(encode("dataEncryptionKey", 'base64'), chr(10), ''),
        'metadataBytes', replace(encode("metadataBytes", 'base64'), chr(10), ''),
        'daemonStateBytes', replace(encode("daemonStateBytes", 'base64'), chr(10), ''),
        'metadataVersion', "metadataVersion", 'daemonStateVersion', "daemonStateVersion") FROM "Machine" WHERE "id"=${quote(machineId)};`));
      await seed({ metadata: encodePredecessor(metadata), daemonState: encodePredecessor(daemonState),
        metadataVersion: initial.metadataVersion + 1, daemonStateVersion: initial.daemonStateVersion + 1 });
      const legacy = await read();
      expect(legacy).toMatchObject({ dataEncryptionKey: null, metadataVersion: initial.metadataVersion + 1 });
      socket = createUserScopedSocketCollector(fixture.server.baseUrl, account.auth.token);
      socket.connect();
      await waitFor(() => socket!.isConnected(), { context: 'concurrent owner editor connected' });
      const editedMetadata = { ...metadata, displayName: 'Concurrent user edit', finitePolicyV1: { accepting: false, runAtMost: 2 } };
      beforeTransition = async () => {
        beforeTransition = undefined;
        const edited = await socket!.emitWithAck<{ result: string }>('machine-update-metadata', {
          machineId, metadata: encodePredecessor(editedMetadata), expectedVersion: legacy.metadataVersion,
          expectedDataEncryptionKey: null,
        });
        expect(edited.result).toBe('success');
      };
      const request: NonNullable<Parameters<ApiClient['prepareMachineContentKey']>[1]>['request'] = async input => {
        return fetchJson<unknown>(`${fixture!.server.baseUrl}${input.path}`, { method: input.method, headers,
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }), signal: input.signal });
      };
      const options = { request, serverHttpBaseUrl: fixture.server.baseUrl };
      const conflicted = await prepareThroughAction();
      expect(conflicted, JSON.stringify({ conflicted, editRan: beforeTransition === undefined })).toMatchObject({ ok: true,
        result: { kind: 'unavailable', code: 'machine_unavailable' } });
      const winner = await read();
      expect(winner).toMatchObject({ dataEncryptionKey: null, daemonState: legacy.daemonState,
        metadataVersion: legacy.metadataVersion + 1, daemonStateVersion: legacy.daemonStateVersion });
      expect(decrypt(account.auth.accountSigningSeed, 'legacy', decodeBase64(winner.metadata!))).toEqual(editedMetadata);

      // Whole historical extensions survive conversion, but correctly prevent
      // their disclosure to recipients until the owner publishes safe content.
      const prepared = await prepareThroughAction();
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, result: { kind: 'pending_holder' } });
      const converted = await api.prepareMachineContentKey(machineId, options);
      if (converted.encryptionMode !== 'e2ee') throw new Error('Expected encrypted conversion');
      const committed = await read();
      expect(committed).toMatchObject({ metadataVersion: winner.metadataVersion + 1, daemonStateVersion: winner.daemonStateVersion + 1 });
      expect(converted.encryptionKey).not.toEqual(account.auth.accountMachineKey);
      expect(converted.encryptionKey).not.toEqual(account.auth.accountSigningSeed);
      expect(decrypt(converted.encryptionKey, 'dataKey', decodeBase64(committed.metadata!))).toEqual(editedMetadata);
      expect(decrypt(converted.encryptionKey, 'dataKey', decodeBase64(committed.daemonState!))).toEqual(daemonState);
      // The editor that was connected before conversion can learn the new
      // version without learning the new key. That version cannot authorize an
      // update encrypted with the predecessor key.
      const staleWrite = await socket.emitWithAck<{ result: string }>('machine-update-metadata', {
        machineId, metadata: encodePredecessor({ ...editedMetadata, displayName: 'Stale editor write' }),
        expectedVersion: committed.metadataVersion, expectedDataEncryptionKey: null,
      });
      expect(staleWrite.result).toBe('key-mismatch');
      expect(await read()).toEqual(committed);
      const restartedReader = await ApiClient.create(structuredClone(predecessorCredentials));
      expect(await restartedReader.prepareMachineContentKey(machineId, options)).toMatchObject({ encryptionKey: converted.encryptionKey });

      // Both malformed and valid-but-unrelated present envelopes must refuse:
      // readable predecessor ciphertext cannot make either an absent envelope.
      for (const envelope of [encodeBase64(new Uint8Array([1, 2, 3])), committed.dataEncryptionKey!]) {
        await seed({ ...winner, metadata: winner.metadata!, dataEncryptionKey: envelope });
        const refused = await prepareThroughAction();
        expect(refused, JSON.stringify(refused)).toMatchObject({ ok: true,
          result: { kind: 'unavailable', code: 'machine_unavailable' } });
        await expect(restartedReader.prepareMachineContentKey(machineId, options)).rejects.toMatchObject({ code: 'machine_content_key_unavailable' });
        // Ordinary projections withhold malformed content. Inspect persistence
        // here to prove refusal did not replace it with readable predecessor data.
        expect(await readPersistedContent()).toMatchObject({ metadata: winner.metadata, daemonState: winner.daemonState,
          dataEncryptionKey: envelope, metadataVersion: winner.metadataVersion, daemonStateVersion: winner.daemonStateVersion });
      }
      await seed({ ...committed, metadata: committed.metadata! });
      await machine.restart();
      await assertDaemonControl();
      await machine.daemon.stop();
      const recipient = await fixture.createAccount('content-key-recipient');
      const recipientId = readAccountIdFromToken(recipient.auth.token);
      if (!recipientId || recipientId === accountId) throw new Error('Expected a separate Machine recipient Account');
      await setUsername(fixture.server.baseUrl, account.auth.token, 'conversion_owner');
      await setUsername(fixture.server.baseUrl, recipient.auth.token, 'conversion_recipient');
      await addFriend(fixture.server.baseUrl, account.auth.token, recipientId);
      await addFriend(fixture.server.baseUrl, recipient.auth.token, accountId);
      const principal = { kind: 'account' as const, accountId: recipientId };
      const granted = await account.executeAsPerson('machines.access.grant.set', { ...machine.target, principal, level: 'view' });
      if (!granted.ok) throw new Error(`Machine share refused (${granted.errorCode})`);
      expect(MachineAccessMutationResultV1Schema.parse(granted.result)).toMatchObject({
        kind: 'saved', grant: { machineId, principal, level: 'view' },
      });

      const restarted = await read();
      // Exercise the disclosure guard with the opaque publication, even when
      // normal daemon metadata updates have published a different projection.
      await seed({ ...committed, metadata: committed.metadata!,
        metadataVersion: restarted.metadataVersion + 1, daemonStateVersion: restarted.daemonStateVersion + 1 });
      const beforePlain = await read();
      const beforePlainMetadata = decrypt(converted.encryptionKey, 'dataKey', decodeBase64(beforePlain.metadata!));
      const beforePlainDaemonState = decrypt(converted.encryptionKey, 'dataKey', decodeBase64(beforePlain.daemonState!));
      expect(beforePlainMetadata).toEqual(editedMetadata);
      expect(beforePlainDaemonState).toEqual(daemonState);
      const beforePlainPersisted = await readPersistedContent();

      // Seed the persisted state produced by fae505bdc691's predecessor PATCH:
      // it changed Account mode without converting existing Machine content.
      // Today's empty-only compatibility PATCH correctly refuses this state.
      await postgres.sql('happier', `UPDATE "Account" SET "encryptionMode"='plain', "encryptionModeUpdatedAt"=now()
        WHERE "id"=${quote(accountId)};`);
      const switched = await fetchJson<unknown>(`${fixture.server.baseUrl}/v1/account/encryption`, { headers });
      expect(switched.status, JSON.stringify(switched.data)).toBe(200);
      expect(switched.data).toMatchObject({ mode: 'plain' });

      // Inspect the raw recipient response while the row still contains E2EE content.
      // Parsing it as a stored read would drop any accidentally disclosed extra fields.
      const recipientRead = await fetchJson<unknown>(`${fixture.server.baseUrl}/v1/machines/${machineId}`, {
        headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${recipient.auth.token}` },
      });
      const { access: ownerAccess, recipientWorkPending: _pending, recipientWorkCursor: _cursor, ...row } = beforePlain;
      if (!ownerAccess) throw new Error('Expected the custodian in the Machine projection');
      expect(recipientRead.status).toBe(200);
      expect(recipientRead.data).toStrictEqual({ machine: {
        ...row,
        storageMode: 'plain',
        metadata: null, daemonState: null, dataEncryptionKey: null,
        devcontainerChild: null, deploymentApp: null, runnerContentKeyBinding: null,
        access: { custodian: ownerAccess.custodian, role: 'use', resourceMode: 'plain',
          accessState: 'refused', reason: 'encryption_material_unavailable' },
      } });

      // Persisted Home mode alone does not discard this computer's active-key custody.
      await expect(restartedReader.prepareMachineContentKey(machineId, options)).rejects.toMatchObject({ code: 'account_mode_downgrade_unverified' });
      const unconfirmed = await prepareThroughAction();
      expect(unconfirmed, JSON.stringify(unconfirmed)).toMatchObject({ ok: true,
        result: { kind: 'unavailable' } });
      expect(await readPersistedContent()).toEqual(beforePlainPersisted);
      // Reconnect with the credentials produced by the person's explicit Keeper
      // confirmation. The gesture itself is outside this conversion journey.
      await ui.close();
      ui = await connectUiActionClient({ serverUrl: home.canonicalServerUrl,
        credentials: { ...buildTestAccountCliAuthCredentials({ auth: account.auth, mode: 'legacy' }), custody: 'historical' } });
      await waitFor(() => ui!.isAccountReady(), { context: 'historical-custody conversion Account ready' });
      const plainPreparation = await prepareThroughAction();
      const afterPlainPreparation = await read();
      expect(plainPreparation, JSON.stringify({ plainPreparation, storageMode: afterPlainPreparation.storageMode }))
        .toMatchObject({ ok: true, result: { kind: 'unavailable', code: 'content_unpublished' } });
      expect(afterPlainPreparation).toMatchObject({ storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
      expect(decodePlainMachineStoredContent(afterPlainPreparation.metadata!)).toEqual(beforePlainMetadata);
      expect(decodePlainMachineStoredContent(afterPlainPreparation.daemonState!)).toEqual(beforePlainDaemonState);
      const confirmedReader = await ApiClient.create({ ...account.credentials, encryption: credentialMaterial,
        accountE2eeCustody: 'historical' });
      const plain = await confirmedReader.prepareMachineContentKey(machineId, options);
      expect(plain.encryptionMode).toBe('plain');
      const plainRow = await read();
      expect(plainRow).toEqual(afterPlainPreparation);
      expect(decodePlainMachineStoredContent(plainRow.metadata!)).toMatchObject({ displayName: editedMetadata.displayName });
      const freshMachineId = randomUUID();
      const installation = createMachineInstallationIdentityFixture();
      const created = await runWithServerHttpBaseUrl(fixture.server.baseUrl, () =>
        confirmedReader.getOrCreateMachine({ machineId: freshMachineId, metadata: converted.metadata!, registrationIdentity: {
          installationId: installation.installationId, installationPublicKey: installation.publicKeyBase64,
          installationProof: buildMachineInstallationProof({ installationId: installation.installationId,
            machineId: freshMachineId, privateKeyBase64: installation.privateKeyBase64,
            accountId }),
        } }));
      expect(created.encryptionMode).toBe('plain');
    } finally {
      socket?.close();
      try { await ui?.close(); } finally {
        try { await fixture?.stop(); } finally { await postgres.stop(); }
      }
    }
  }, 0);
});

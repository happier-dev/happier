import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { DATABASE_PLUGIN_ID_V1, DATABASE_TARGETS_LIST_ACTION_ID_V1, databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { DatabaseTargetsListResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createServerLightDatabaseClient } from '../../src/testkit/process/serverLightDatabase';
import { createRunDirs } from '../../src/testkit/runDir';
import { encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';

const run = createRunDirs({ runLabel: 'dbw-p1-discovery-census' });
const actionAdmissionPath = bindExternalActionExecutionAuthorizationHttpPathV1(ACTION_INVOKE_ACTION_ID_V1);
const actionDispatchPath = `/v1/actions/${ACTION_INVOKE_ACTION_ID_V1}`;

it('F1 discovers the same selected target without scanning unrelated Home Machines and Sessions', async () => {
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('selected-target') });
  try {
    const action = { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1) };
    const { machineId } = fixture.machine.target;
    await fixture.owner.withPersonActionClient(async execute => {
      const observe = async () => {
        fixture.takeRequestObservations();
        const listed = await execute('action.invoke', { action, input: { scope: fixture.scope } }, { externalActionTarget: { kind: 'machine', machineId } });
        if (!listed.ok) throw new Error(`Selected discovery refused (${listed.errorCode})`);
        const result = DatabaseTargetsListResultV1Schema.parse(listed.result);
        expect(result).toMatchObject({ completeness: { complete: true }, targets: expect.arrayContaining([
          expect.objectContaining({ target: fixture.targets.selected }),
          expect.objectContaining({ target: fixture.targets.neighbor }),
        ]) });
        const observations = fixture.takeRequestObservations();
        const aggregateReads = observations.filter(request =>
          request.method === 'GET' && /^\/v\d+\/(?:machines|sessions(?:\/active)?)(?:\?|$)/u.test(request.path));
        expect(aggregateReads).toEqual([]);
        expect(observations.filter(request => request.method === 'POST' && request.path === actionAdmissionPath)).toHaveLength(1);
        expect(observations.filter(request => request.method === 'POST' && request.path === actionDispatchPath)).toHaveLength(1);
        return result;
      };
      const baseline = await observe();
      const accountId = fixture.scope.accountId;
      const dataKey = randomBytes(32);
      const credentials = fixture.owner.credentials;
      if (!('encryption' in credentials)) throw new Error('Discovery fixture requires E2EE Machine and Session envelopes');
      const wrapped = sealEncryptedDataKeyEnvelopeV1({
        dataKey, recipientPublicKey: credentials.encryption.publicKey, randomBytes,
      });
      const machines = Array.from({ length: 100 }, () => ({
        id: randomUUID(), accountId, dataEncryptionKey: wrapped,
        metadata: encryptDataKeyBase64({ host: 'unrelated', platform: 'linux', homeDir: '/home/unrelated',
          happyHomeDir: '/home/unrelated/.happier', happyCliVersion: 'test' }, dataKey),
      }));
      const sessions = Array.from({ length: 1_000 }, (_, index) => ({
        id: randomUUID(), accountId, tag: randomUUID(),
        metadata: encryptDataKeyBase64({ path: '/home/unrelated', machineId: machines[index % machines.length]!.id,
          host: 'unrelated', flavor: 'claude' }, dataKey), agentState: encryptDataKeyBase64({ requests: {} }, dataKey),
      }));
      const db = await createServerLightDatabaseClient('postgres', fixture.postgres.homeDatabaseUrl);
      try {
        await db.$transaction(async tx => {
          expect(await tx.machine.createMany({ data: machines })).toEqual({ count: machines.length });
          expect(await tx.session.createMany({ data: sessions })).toEqual({ count: sessions.length });
          expect(await tx.sessionDataKeyEnvelope.createMany({
            data: sessions.map(({ id }) => ({ sessionId: id, recipientAccountId: accountId, encryptedDataKey: wrapped })),
          })).toEqual({ count: sessions.length });
        });
      } finally {
        await db.$disconnect();
      }
      expect(await observe()).toEqual(baseline);
      console.info('DBW_P1_DISCOVERY_REQUESTS', { machines: machines.length, sessions: sessions.length,
        admissionsPerDiscovery: 1, dispatchesPerDiscovery: 1, aggregateReadsPerDiscovery: 0 });
    }, { presentation: { action, machineId } });
  } finally {
    await fixture.stop();
  }
}, 0);

import axios from 'axios';
import { access, readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol';
import { createProjectSessionRuntimeFixture } from '../testkit/projectSessionRuntimeFixture';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { listRequesterSessionCredentialBindings } from '../sessionEncryption/requesterSessionCredentials';
import { readSessionMarker, writeSessionMarker } from '../sessionRegistry';
import { publishOrphanedStartupSessionEnds } from './publishOrphanedStartupSessionEnds';
import { retireOrphanedTerminalControlServiceability } from './retireOrphanedTerminalControlServiceability';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

it.each(['entitled', 'withdrawn', 'ambiguous', 'preparing-successor', 'wrong-home'] as const)(
  'preserves requester credential custody while retiring an %s orphan', async state => {
    const f = await createProjectSessionRuntimeFixture({ boundSessionId: 'orphan',
      machineAccess: { custodianAccountId: 'custodian', role: 'use' } });
    const bootstrap = f.bootstrap;
    const pid = 999_312_859;
    const marker = { trackingKey: legacyPidSessionTrackingKey(pid), sessionId: 'orphan', pid, processStartTimeMs: 123,
      requesterWorkAttributionV1: state === 'wrong-home' ? { ...bootstrap.attribution, serverId: 'other-home' } : bootstrap.attribution };
    await writeSessionMarker({ trackingKey: marker.trackingKey, pid, happySessionId: marker.sessionId, startedBy: 'daemon',
      processStartTimeMs: marker.processStartTimeMs, requesterWorkAttributionV1: marker.requesterWorkAttributionV1 });
    const existingGet = vi.mocked(axios.get).getMockImplementation();
    vi.mocked(axios.get).mockImplementation(async (url, config) => {
      if (String(url).endsWith('/v1/access-keys/orphan/machine')) return { status: 200, data: { accessKey: { data: 'opaque' } } };
      if (String(url).endsWith('/v2/sessions/orphan')) return { status: 200, data: { session: createSessionRecordFixture({
        id: 'orphan', encryptionMode: 'plain', metadataLayoutVersion: 0, metadataVersion: 1,
        metadata: JSON.stringify({ machineId: 'machine', path: f.directory, hostPid: pid, hostProcessStartTimeMs: 123 }),
      }) } };
      if (!existingGet) throw new Error('Missing Home boundary');
      return existingGet(url, config);
    });
    const custody = await bootstrap.bindExistingSession('orphan');
    if (!custody) throw new Error('Missing actual retained requester custody');
    const before = await readFile(custody.path, 'utf8');
    if (state === 'withdrawn') f.retire();
    const patches: unknown[] = [];
    vi.spyOn(axios, 'patch').mockImplementation(async (_url, body, config) => {
      expect(config?.headers?.Authorization).toBe(`Bearer ${bootstrap.credentials.token}`);
      patches.push(SessionMetadataTuplePatchV1Schema.parse(body));
      return { status: 200, data: { success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: 2 }, agentState: { version: 0 } } };
    });
    let proofRequests = 0;
    vi.spyOn(axios, 'post').mockImplementation(async () => {
      proofRequests++;
      throw new Error('Terminal settlement must not reauthorize machine access');
    });
    const requester = { bootstrap, isCurrent: bootstrap.isCurrent };
    const params = { marker,
      credentials: { token: 'custodian-fixture', encryption: null },
      resolveRequesterSessionRuntimeContext: async () => state === 'withdrawn' || state === 'ambiguous' || state === 'preparing-successor' || state === 'wrong-home'
        ? null : await bootstrap.isCurrent() ? requester : null,
      releaseRequesterSessionRuntimeContext: async () => undefined };
    const retained = await publishOrphanedStartupSessionEnds({ serverId: bootstrap.attribution.serverId, orphanedDeadDaemonSessions: [marker],
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd: async () => undefined,
        captureMachineSessionTerminal: async () => ({ v: 1, status: 'captured', sessionId: 'orphan',
          authority: { kind: 'generation', publisherGeneration: '1' } }),
        finalizeMachineSessionTerminal: async () => {
          if (state === 'preparing-successor') {
            // The real launch owner publishes custody before any child or lock exists.
            expect(await bootstrap.bindExistingSession('orphan')).not.toBeNull();
          }
          return { v: 1, status: state === 'preparing-successor' ? 'superseded' : 'closed', sessionId: 'orphan' };
        },
      },
      retireTerminalControlServiceability: async () => retireOrphanedTerminalControlServiceability(params),
    });
    await expect(access(custody.path)).resolves.toBeUndefined();
    expect(await readFile(custody.path, 'utf8')).toBe(before);
    const discovery = await listRequesterSessionCredentialBindings({ happyHomeDir: f.directory,
      serverId: bootstrap.attribution.serverId, machineId: 'machine', installationId: f.installation.installationId });
    expect(discovery).toMatchObject({ status: 'ready', bindings: [{ sessionId: 'orphan', attribution: bootstrap.attribution }] });
    if (state === 'entitled') {
      expect(patches).toEqual(expect.arrayContaining([expect.objectContaining({
        ownerMetadata: expect.objectContaining({ t: 'plain', v: expect.objectContaining({
          runtime: expect.objectContaining({ terminal: expect.objectContaining({ controlServiceabilityV1: expect.objectContaining({ retired: true }) }) }),
        }) }),
      })]));
      expect(await bootstrap.isCurrent()).toBe(true);
      expect(proofRequests).toBe(0);
    } else {
      expect(patches).toHaveLength(0);
      expect(proofRequests).toBe(0);
    }
    expect(retained).toEqual(state === 'wrong-home' ? [marker] : []);
    expect(await readSessionMarker(marker.trackingKey)).toEqual(state === 'wrong-home' ? expect.anything() : null);
    if (state === 'wrong-home') return;
    const requestsAfterSettlement = { patches: patches.length, proofs: proofRequests };
    await publishOrphanedStartupSessionEnds({ serverId: bootstrap.attribution.serverId, orphanedDeadDaemonSessions: retained,
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd: async () => { throw new Error('Settled marker was replayed'); },
        captureMachineSessionTerminal: async () => { throw new Error('Settled terminal was recaptured'); },
        finalizeMachineSessionTerminal: async () => { throw new Error('Settled terminal was refinalized'); },
      },
      retireTerminalControlServiceability: async () => retireOrphanedTerminalControlServiceability(params),
    });
    expect({ patches: patches.length, proofs: proofRequests }).toEqual(requestsAfterSettlement);
  },
);

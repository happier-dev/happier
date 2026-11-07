import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';
import { createExternalSessionFollowHostOperation } from '@/session/external/followHostOperation';
import { createExternalSessionFollowTargetHostOperation } from '@/session/external/followTargetHostOperation';
import { createExternalSessionFollowLeaseManager } from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';
import { resolveExternalSessionSourceSurface } from '@/session/actions/externalSessions/providerOpsResolution';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { writeCredentialsTokenOnly, writeStoredCredentialsForServerId } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { HostExternalTranscriptFollowEvent } from '@/session/external/privateContract';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Substitute only the daemon's OS listener; custody selection and both host operations stay real.
vi.mock('@/daemon/controlServer', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlServer')>(),
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43128, stop: async () => {} };
  },
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); boundary.control = null; });

it.each(['guest', 'guest-provider-target', 'guest-run-provider-target', 'guest-run-inaccessible-session', 'guest-external-without-identity', 'owner', 'mismatched-session'] as const)('follows the native Claude transcript through installed Session Account custody (%s)', async kind => {
  const runTarget = kind === 'guest-run-provider-target' || kind === 'guest-run-inaccessible-session';
  const omitsNativeIdentity = runTarget || kind === 'guest-external-without-identity';
  const owner = createExternalSessionHostOperationOwner();
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, 'claude', false, undefined, undefined,
    { externalSessionHostOperationOwner: owner, ...(kind === 'owner' ? {
      ordinaryAccountSession: true, externalActionAccountId: 'requester',
    } : {}) });
  onTestFinished(() => owner.retire());
  const guest = kind === 'owner' ? h.installedCredentials : h.requester.bootstrap.credentials;
  if (!guest) throw new Error('Canonical fixture credentials unavailable');
  const custodian = { token: 'custodian-token', encryption: null };
  // The physical installation retains its own Account, while the hosted Session belongs to the requester.
  await writeCredentialsTokenOnly(kind === 'owner' ? guest : custodian);
  await writeStoredCredentialsForServerId(h.requester.bootstrap.attribution.serverId, kind === 'owner' ? guest : custodian);
  const remoteSessionId = '33333333-3333-3333-3333-333333333333';
  const configDir = join(h.cwd, 'requester-claude');
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
  const projectId = '-project';
  const nativePath = join(configDir, 'projects', projectId, `${remoteSessionId}.jsonl`);
  await mkdir(join(configDir, 'projects', projectId), { recursive: true });
  await writeFile(nativePath, JSON.stringify({ type: 'user', uuid: 'native-user', sessionId: remoteSessionId,
    timestamp: new Date().toISOString(), message: { role: 'user', content: 'fixture prompt' } }) + '\n'
    + JSON.stringify({ type: 'assistant', uuid: 'native-answer', parentUuid: 'native-user', sessionId: remoteSessionId,
      timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'fixture complete' }], stop_reason: 'end_turn' } }) + '\n');
  const raw = { ...createSessionNotificationContextFixture(h.sessionId), currentStorageState: 'hosted' as const,
    encryptionMode: 'plain' as const, metadata: JSON.stringify({ machineId: 'machine', path: h.cwd, flavor: 'claude',
      ...(omitsNativeIdentity ? {} : { claudeSessionId: remoteSessionId, nativeSessionLogPath: nativePath }) }) };
  const previousGet = vi.mocked(axios.get).getMockImplementation();
  const reads: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname === `/v2/sessions/${h.sessionId}`) {
      const authorized = options?.headers?.Authorization === `Bearer ${guest.token}`;
      reads.push(authorized ? 'guest' : 'custodian');
      const accessible = authorized && kind !== 'guest-run-inaccessible-session';
      return { status: accessible ? 200 : 404, data: accessible ? { session: raw } : { error: 'session_not_found' } };
    }
    if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (!previousGet) throw new Error('Fixture Home transport unavailable');
    return await previousGet(input, options);
  });
  const manager = createExternalSessionFollowLeaseManager({ writeFollowStatus: async () => {} });
  const projection = createExternalSessionObservationDaemonProjection({ publishField: async () => {},
    requestTranscriptRefresh: input => manager.requestTranscriptRefresh(input),
    isTranscriptRefreshDemanded: input => manager.hasTranscriptDemand(input) });
  onTestFinished(() => manager.dispose());
  await h.daemon.installExternalSessionHostOperations({
    followOperation: createExternalSessionFollowHostOperation({ machineId: 'machine', followLeaseManager: manager, observationProjection: projection }),
    followTargetOperation: createExternalSessionFollowTargetHostOperation({ machineId: 'machine' }),
  });
  const source = { kind: 'claudeConfig' as const, configDir, projectId };
  const surface = await resolveExternalSessionSourceSurface('claude', source);
  if (!surface.ok || !surface.providerOps.validateSource || !surface.providerOps.resolveLinkIdentity
    || !surface.providerOps.pageTranscript || !surface.providerOps.readAfterTranscript) throw new Error('Native Claude surface unavailable');
  const agent = h.plugin.registry.contributes.agentDefinitionsById.get('claude');
  if (!agent) throw new Error('Claude contribution unavailable');
  const port = owner.bind({ pluginId: h.retainedAgent.pluginId, agentId: 'claude', occurrenceId: 'runner-generation',
    sessionId: h.sessionId, machineId: 'machine', readAccountRevision: () => 'retained-account', isOccurrenceCurrent: () => true,
    agentContribution: agent });
  const events: HostExternalTranscriptFollowEvent[] = [];
  if (kind === 'mismatched-session') {
    h.tracked.requesterWorkAttributionV1 = { ...h.requester.bootstrap.attribution, accountId: 'another-account' };
  }
  const attempt = runWithServerHttpBaseUrl('https://session-home.test', async () => kind === 'guest-provider-target' || runTarget
    ? await port.executeProviderSessionFollow({ agentId: 'claude', providerSessionId: remoteSessionId,
      providerOps: { validateSource: surface.providerOps.validateSource!, resolveLinkIdentity: surface.providerOps.resolveLinkIdentity!,
        pageTranscript: surface.providerOps.pageTranscript!, readAfterTranscript: surface.providerOps.readAfterTranscript! },
      options: { projection: 'terminal', initialReplay: true, replay: 'fresh' }, listener: event => { events.push(event); },
    }) : await port.executeFollow({
    ref: { agentId: 'claude', sourceId: 'native-source', remoteSessionId }, source,
    providerOps: { pageTranscript: surface.providerOps.pageTranscript!, readAfterTranscript: surface.providerOps.readAfterTranscript! },
    options: { projection: 'terminal', initialReplay: true, replay: 'fresh' }, listener: event => { events.push(event); },
  }));
  if (kind === 'mismatched-session') {
    await expect(attempt).rejects.toThrow();
    expect(reads).toEqual([]);
    expect(events).toEqual([]);
    return;
  }
  const result = await attempt;
  if (kind === 'guest-external-without-identity' || kind === 'guest-run-inaccessible-session') {
    expect(result).toEqual({ status: 'unavailable', code: 'invalid_request' });
    expect(events).toEqual([]);
    expect(reads).toEqual(['guest']);
    return;
  }
  expect(result.status, `Installed follow outcome ${JSON.stringify(result)}; Session readers ${reads.join(',')}`).toBe('following');
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every(account => account === 'guest')).toBe(true);
  expect(events.some(event => event.kind === 'data')).toBe(true);
  if (runTarget && result.status === 'following') {
    const metadataBeforeAppend = raw.metadata;
    await appendFile(nativePath, JSON.stringify({ type: 'assistant', uuid: 'native-followup', parentUuid: 'native-answer',
      sessionId: remoteSessionId, timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'native followup' }], stop_reason: 'end_turn' } }) + '\n');
    await vi.waitFor(() => expect(events.some(event => event.kind === 'data'
      && event.items.some(item => JSON.stringify(item.data).includes('native followup'))),
      `Delivered fixture event identities: ${events.map(event => event.kind === 'data' ? event.items.map(item => item.id).join(',') : event.kind).join(';')}`)
      .toBe(true), { timeout: 5_000 });
    expect(raw.metadata).toBe(metadataBeforeAppend);
    // One Account admission, with no parent-native-identity rechecks during the Run.
    expect(reads).toEqual(['guest']);
  }
  if (result.status === 'following') await result.subscription.dispose();
});

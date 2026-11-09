import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { createProjectSessionRuntimeFixture } from '../testkit/projectSessionRuntimeFixture';
import { readHostAccountExecutionIdentity } from '../agentIsolation/agentIsolationAccountCustody';
import { createRequesterSessionCredentialCustody } from './requesterSessionCredentials';
import { readOrdinaryRequesterSessionAccountCustodyForHost, readOrdinaryRequesterSessionAccountOperationContextForHost } from './ordinaryRequesterSessionAccountCustody';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

it.each(['owner', 'guestUse', 'foreignSession', 'foreignAccount', 'foreignHome', 'retainedBirth', 'ambientOtherAccount'] as const)(
  'qualifies captured ordinary Session custody and Account context (%s)', async scenario => {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    const fixture = await createProjectSessionRuntimeFixture({ serverId: 'owner-profile',
      homeServerIdentityId: 'srv_canonical-owner-home', credentials: { ...credentials },
      ...(scenario === 'guestUse' ? { machineAccess: { custodianAccountId: 'company', role: 'use' as const } } : {}) });
    const attribution = fixture.bootstrap.attribution;
    const homeServerIdentityId = fixture.bootstrap.homeServerIdentityId!;
    const identity = await readHostAccountExecutionIdentity({ credentials, catalogCredentials: credentials,
      kind: 'agent', machineId: attribution.machineId, hostHomeServerIdentityId: homeServerIdentityId,
      serverHttpBaseUrl: fixture.bootstrap.serverHttpBaseUrl, isCurrent: fixture.isHomeCurrent });
    expect(identity).toMatchObject({ kind: 'isolated', separationRequired: scenario === 'guestUse' });
    if (identity.kind !== 'isolated') throw new Error('Authenticated host Account unavailable');
    const session = await fetchSessionById({ token: credentials.token, sessionId: scenario === 'foreignSession'
      ? 'different-session' : 'ordinary-session', serverUrl: fixture.bootstrap.serverHttpBaseUrl,
      reason: 'requester-binding' });
    if (!session) throw new Error('Captured Session unavailable');
    if (scenario === 'retainedBirth') await createRequesterSessionCredentialCustody({ happyHomeDir: fixture.directory,
      sessionId: 'ordinary-session', attribution, credentials: { ...credentials } });
    const captured = { session, homeServerIdentityId: scenario === 'foreignHome' ? 'other-home' : homeServerIdentityId,
      hostAccountAgent: { accountId: scenario === 'foreignAccount' ? 'other-account' : identity.requester.accountId,
        custodianAccountId: scenario === 'guestUse' ? 'company' : attribution.accountId, machineId: identity.requester.machineId,
        installationId: identity.requester.installationId } };
    const reads = vi.mocked(axios.get).mock.calls.length;
    const input = { happyHomeDir: fixture.directory,
      serverId: attribution.serverId, serverHttpBaseUrl: fixture.bootstrap.serverHttpBaseUrl,
      sessionId: 'ordinary-session', machineId: attribution.machineId,
      hostHomeServerIdentityId: homeServerIdentityId, sessionCustodianAccountId: captured.hostAccountAgent.custodianAccountId,
      credentials, attribution, isCurrent: fixture.isHomeCurrent,
      captured,
    };
    const custody = await readOrdinaryRequesterSessionAccountCustodyForHost(input);
    const ordinaryOwner = scenario === 'owner' || scenario === 'ambientOtherAccount';
    if (ordinaryOwner) expect(custody?.attribution).toEqual(attribution);
    else expect(custody).toBeNull();
    expect(vi.mocked(axios.get).mock.calls.length - reads).toBe(0);
    const snapshot = fixture.bootstrap.accountSettingsContext;
    setActiveAccountSettingsSnapshot({ ...snapshot, ...(scenario === 'ambientOtherAccount' ? { scopeKey: 'another-account' } : {}) });
    const settingsReads = () => vi.mocked(axios.get).mock.calls.filter(([url]) => /\/v[12]\/account\/settings$/u.test(String(url))).length;
    const beforeSettings = settingsReads();
    const operation = await readOrdinaryRequesterSessionAccountOperationContextForHost(input);
    if (ordinaryOwner) {
      expect(operation?.credentials.token).toBe(credentials.token);
      expect(operation?.readSnapshot()?.scopeKey).toBe(snapshot.scopeKey);
      expect(operation?.machineAdmission).toMatchObject({ actorAccountId: attribution.accountId, custodianAccountId: attribution.accountId });
      operation?.withdrawCatalog();
    } else expect(operation).toBeNull();
    // One Settings read builds the admitted Account's private snapshot. Refused
    // custody never reads another Account's content.
    expect(settingsReads() - beforeSettings).toBe(ordinaryOwner ? 1 : 0);
  });

import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '../accountSettings/activeAccountSettingsSnapshot';

import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { refreshActiveApprovalProfileCatalog, refreshDemandedActiveApprovalProfileCatalog } from './hydrateProfileCatalog';
import { resolveAccountSettingsScopeKey } from '../accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import * as persistence from '@/persistence';
import { artifactListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { DeploymentReceiptAcceptedResultV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptResultV1';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

describe('a failed approval profile re-read never withdraws a Session profile', () => {
  const credentials = { token: 'approval-profile-refresh-failure', encryption: null };
  const snapshot = { source: 'network' as const, scopeKey: resolveAccountSettingsScopeKey(credentials),
    settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] };
  // The Account waives agent deploy approval; the Session's Team profile turns deploys Off.
  const accountPolicy = normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: { 'deployments.deploy': ['agent'] } });
  const teamProfileRow = { id: 'team-no-deploys', ownerAccountId: 'team-owner', access: 'owner', encryptionMode: 'plain',
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    header: encodePlainArtifactStoredContent({ kind: 'approval-profile.v1', name: 'No agent deploys' }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'approval-profile.v1',
      profile: { name: 'No agent deploys', actions: { 'deployments.deploy': { enabled: false } } } }) }) };
  const deployInput = { serverId: 'home', environmentId: 'environment', expectedRevision: 3, requestKey: 'deploy-request',
    targetLinkId: 'link', expectedTargetLinkRevision: 4, contentArtifactId: 'definition', contentHeaderVersion: 1, contentBodyVersion: 1 };

  /** Home's HTTP answers are the only boundary: Artifact codec, catalog owner and admission stay real. */
  function serveHome(home: { rows: (typeof teamProfileRow)[]; listStatus?: number; readStatus?: number }) {
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const url = String(input);
      const path = new URL(url).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/artifacts') {
        return home.listStatus ? { status: home.listStatus, data: { error: 'refused' } }
          : { status: 200, data: artifactListResponse(url, home.rows.map(row => ({ ...row, body: undefined }))) };
      }
      const row = home.rows.find(candidate => path === `/v1/artifacts/${candidate.id}`);
      if (home.readStatus) return { status: home.readStatus, data: { error: 'refused' } };
      return row ? { status: 200, data: { ...row, publicAudience: 'none' } } : { status: 404, data: { error: 'Artifact not found' } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) =>
      artifactReadResponse(body, id => home.rows.find(row => row.id === id) ?? null));
  }

  /** The next Action admission, with the CLI's own approval profile reader. */
  async function deployFromSession(): Promise<Readonly<{ result: unknown; effects: number }>> {
    const readApprovalProfile = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'session-with-team-profile',
      serverHttpBaseUrl: 'http://approval-refresh.test' }).readApprovalProfile as ActionExecutorDeps['readApprovalProfile'];
    let effects = 0;
    const executor = createActionExecutor({
      // The Session metadata store and the deployment provider are process boundaries.
      readActionApprovalProfileId: async () => ({ approvalProfileId: teamProfileRow.id, approvalProfileTeamOrGroupDerived: true }),
      readApprovalProfile,
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      prepareDeploymentAction: async () => ({ input: deployInput, preview: { sourceMethod: 'gitIntegration' } }),
      deploymentAction: async () => { effects++; return DeploymentReceiptAcceptedResultV1Schema.parse({ ok: true,
        environmentId: 'environment', revision: 4, kind: 'pending', actionOperationId: 'operation' }); },
    });
    const result = await executor.execute('deployments.deploy', deployInput, { surface: 'agent', authority: 'account_automation',
      serverId: 'home', interactivePresentation: 'unavailable', actionsSettings: accountPolicy });
    return { result, effects };
  }

  async function hydrateTeamProfile() {
    setActiveAccountSettingsSnapshot(snapshot);
    serveHome({ rows: [teamProfileRow] });
    await runWithServerHttpBaseUrl('http://approval-refresh.test', () => refreshActiveApprovalProfileCatalog({ credentials }));
    expect(await deployFromSession()).toEqual({ result: expect.objectContaining({ ok: false, errorCode: 'action_disabled' }), effects: 0 });
    vi.restoreAllMocks();
  }

  it.each([
    { name: 'rate limited list', listStatus: 429 },
    { name: 'unauthorized list', listStatus: 401 },
    { name: 'forbidden list', listStatus: 403 },
    { name: 'conflicting list', listStatus: 409 },
    { name: 'rate limited changed-profile read', readStatus: 429, artifactIds: [teamProfileRow.id] },
  ])('keeps the ready Team profile after a $name and the next admission still applies it', async ({ listStatus, readStatus, artifactIds }) => {
    await hydrateTeamProfile();
    serveHome({ rows: [teamProfileRow], listStatus, readStatus });
    // The Session runner's connect/change path re-reads the demanded catalog.
    await runWithServerHttpBaseUrl('http://approval-refresh.test', () =>
      refreshDemandedActiveApprovalProfileCatalog({ token: credentials.token, ...(artifactIds ? { artifactIds } : {}) }));
    expect(getActiveAccountSettingsSnapshot()?.approvalProfileCatalog?.map(row => row.id)).toEqual([teamProfileRow.id]);
    expect(await deployFromSession()).toEqual({ result: expect.objectContaining({ ok: false, errorCode: 'action_disabled' }), effects: 0 });
  });

  it('refuses admission as approval_context_unavailable when the first read fails', async () => {
    setActiveAccountSettingsSnapshot(snapshot);
    serveHome({ rows: [teamProfileRow], listStatus: 429 });
    expect(await deployFromSession()).toEqual({ result: expect.objectContaining({ ok: false, errorCode: 'approval_context_unavailable' }), effects: 0 });
    expect(getActiveAccountSettingsSnapshot()?.approvalProfileCatalog).toBeUndefined();
  });

  it('withdraws a profile that a successful re-read no longer returns', async () => {
    await hydrateTeamProfile();
    serveHome({ rows: [] });
    await runWithServerHttpBaseUrl('http://approval-refresh.test', () =>
      refreshDemandedActiveApprovalProfileCatalog({ token: credentials.token }));
    expect(getActiveAccountSettingsSnapshot()?.approvalProfileCatalog).toEqual([]);
    expect(await deployFromSession()).toEqual({ result: expect.objectContaining({ ok: true }), effects: 1 });
  });
});

it('retains opened approval profiles across a preference revision and retires them with the Account', () => {
  const snapshot = { source: 'network' as const, scopeKey: 'first', settings: accountSettingsParse({}),
    rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] };
  const approvalProfileCatalog = [{ id: 'profile', profile: { id: 'profile', name: 'Review' },
    access: 'owner' as const, revision: { headerVersion: 1, bodyVersion: 1 } }];
  setActiveAccountSettingsSnapshot({ ...snapshot, approvalProfileCatalog });
  setActiveAccountSettingsSnapshot({ ...snapshot, settingsVersion: 2 });
  expect(getActiveAccountSettingsSnapshot()?.approvalProfileCatalog).toBe(approvalProfileCatalog);
  setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: 'second', settingsVersion: 3 });
  expect(getActiveAccountSettingsSnapshot()?.approvalProfileCatalog).toBeUndefined();
});

it('binds three requests from 50 held rows with zero reads and cannot retarget a retired Account', async () => {
  const credentials = { token: 'approval-profile-held-reader', encryption: null };
  await runWithServerHttpBaseUrl('http://approval-held.test', async () => {
    const snapshot = { source: 'network' as const, scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] };
    const approvalProfileCatalog = Array.from({ length: 50 }, (_, index) => ({ id: `profile-${index}`,
      profile: { id: `profile-${index}`, name: `Review ${index}` }, access: 'owner' as const,
      revision: { headerVersion: 1, bodyVersion: 1 } }));
    setActiveAccountSettingsSnapshot({ ...snapshot, approvalProfileCatalog });
    const get = vi.spyOn(axios, 'get').mockRejectedValue(Object.assign(new Error('No transport during warm binding'), { code: 'ECONNREFUSED' }));
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'profile-reader',
      serverHttpBaseUrl: 'http://approval-held.test' });
    for (let request = 0; request < 3; request++) expect(await deps.readApprovalProfile?.('profile-25', { surface: 'agent' }))
      .toMatchObject({ profile: approvalProfileCatalog[25]?.profile, resolution: { status: 'available', requestedId: 'profile-25' } });
    expect(get).not.toHaveBeenCalled();
    setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: 'other-account' });
    await expect(deps.readApprovalProfile?.('profile-25', { surface: 'agent' })).resolves.toMatchObject({
      profile: null, resolution: { status: 'missing', requestedId: 'profile-25' } });
    expect(get).not.toHaveBeenCalled();
  });
});

it('reobserves an Artifact wake received while the cold catalog is opening', async () => {
  const credentials = { token: 'approval-profile-cold-wake', encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
    settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
  // HTTP and stored credentials are system boundaries; catalog lifecycle and codecs remain real.
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  let revision = 1;
  let bodyReads = 0;
  let observed!: () => void;
  const opened = new Promise<void>(resolve => { observed = resolve; });
  let release!: () => void;
  const admission = new Promise<void>(resolve => { release = resolve; });
  const row = () => ({ id: 'picked', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: revision, bodyVersion: revision,
    seq: revision, createdAt: 1, updatedAt: revision,
    header: encodePlainArtifactStoredContent({ kind: 'approval-profile.v1', name: `Review ${revision}` }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'approval-profile.v1', profile: { name: `Review ${revision}` } }) }) });
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const url = String(input);
    if (new URL(url).pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (new URL(url).pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    expect(new URL(url).pathname).toBe('/v1/artifacts');
    return { status: 200, data: artifactListResponse(url, [{ ...row(), body: undefined }]) };
  });
  vi.spyOn(axios, 'post').mockImplementation(async (_url, input) => {
    const selected = row();
    bodyReads++;
    if (bodyReads === 1) { observed(); await admission; }
    return artifactReadResponse(input, id => id === selected.id ? selected : null);
  });
  await runWithServerHttpBaseUrl('http://approval-catalog.test', async () => {
    const first = refreshActiveApprovalProfileCatalog({ credentials });
    await opened;
    revision = 2;
    const wake = refreshDemandedActiveApprovalProfileCatalog({ token: credentials.token });
    release();
    await Promise.all([first, wake]);
    expect(getActiveAccountSettingsSnapshot()?.approvalProfileCatalog?.[0]?.profile.name).toBe('Review 2');
    expect(bodyReads).toBe(2);
  });
});

it('refreshes one changed profile among 50 held rows and removes a withdrawn opening', async () => {
  const credentials = { token: 'approval-profile-exact-wake', encryption: null };
  await runWithServerHttpBaseUrl('http://approval-exact.test', async () => {
    const catalog = Array.from({ length: 50 }, (_, index) => ({ id: `profile-${index}`,
      profile: { id: `profile-${index}`, name: `Review ${index}` }, access: 'owner' as const,
      revision: { headerVersion: 1, bodyVersion: 1 } }));
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [], approvalProfileCatalog: catalog });
    let available = true;
    let bodyReads = 0;
    let lists = 0;
    // The real Artifact reader/codec receives Home's HTTP response; unrelated rows stay held.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/artifacts') {
        lists++;
        throw new Error('A known changed id must not reload the catalog');
      }
      expect(path).toBe('/v1/artifacts/profile-25');
      bodyReads++;
      return !available ? { status: 404, data: { error: 'artifact_not_found' } } : { status: 200, data: {
        id: 'profile-25', ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 2, bodyVersion: 2,
        seq: 2, createdAt: 1, updatedAt: 2,
        header: encodePlainArtifactStoredContent({ kind: 'approval-profile.v1', name: 'Updated policy' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'approval-profile.v1', profile: { name: 'Updated policy' } }) }),
      } };
    });
    const updated = await refreshActiveApprovalProfileCatalog({ credentials, artifactIds: ['profile-25'] });
    expect(updated.find(row => row.id === 'profile-25')?.profile.name).toBe('Updated policy');
    expect(updated.find(row => row.id === 'profile-24')).toBe(catalog[24]);
    expect(bodyReads).toBe(1);
    expect(lists).toBe(0);
    available = false;
    const withdrawn = await refreshActiveApprovalProfileCatalog({ credentials, artifactIds: ['profile-25'] });
    expect(withdrawn.find(row => row.id === 'profile-25')).toBeUndefined();
    expect(withdrawn).toHaveLength(49);
    expect(bodyReads).toBe(2);
    expect(lists).toBe(0);
  });
});

it('keeps held policy while Home is unreachable and refuses an unavailable cold read', async () => {
  const credentials = { token: 'approval-profile-offline', encryption: null };
  const snapshot = { source: 'network' as const, scopeKey: resolveAccountSettingsScopeKey(credentials),
    settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] };
  const approvalProfileCatalog = [{ id: 'picked', profile: { id: 'picked', name: 'Held policy' }, access: 'owner' as const,
    revision: { headerVersion: 1, bodyVersion: 1 } }];
  setActiveAccountSettingsSnapshot({ ...snapshot, approvalProfileCatalog });
  vi.spyOn(axios, 'get').mockRejectedValue(Object.assign(new Error('Home unreachable'), { code: 'ECONNREFUSED' }));
  await runWithServerHttpBaseUrl('http://approval-offline.test', async () => {
    expect(await refreshActiveApprovalProfileCatalog({ credentials })).toBe(approvalProfileCatalog);
    setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: 'retired' });
    setActiveAccountSettingsSnapshot(snapshot);
    await expect(refreshActiveApprovalProfileCatalog({ credentials })).rejects.toThrow();
  });
});

import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import type { RpcHandler, RpcHandlerRegistrar, RpcHandlerContext } from '@/api/rpc/types';
import { registerProjectOpenRpcHandlers } from '@/rpc/handlers/projects/registerProjectOpenRpcHandlers';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { projectAccountRowReadResponse } from '@/testkit/http/projectAccountRows';
import { createProjectSetupTrustRowCipher } from '@/workspaces/projectSetup/projectSetupTrust';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { logger } from '@/ui/logger';

// Match the real owner suite: daemon composition import belongs to collection,
// so cold transformation cannot consume an individual operation deadline.
await import('@/api/api');

const roots: string[] = [];
beforeEach(async () => {
  await seedTestServerProfile({ id: 'srv_test_home', homeId: 'srv_test_home', serverUrl: 'https://home.example' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  withdrawActiveProjectAccountRowsSnapshot();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('MI-R3 registered Project Open authority/effect boundary', () => {
  it.each(['owner', 'owner-automation', 'owner-admitted-once', 'member-a', 'member-b'])('preserves owner acceptance but never converts %s Account rows into a private-root grant', async scenario => {
    const accountId = scenario.startsWith('owner') ? 'owner' : scenario;
    const root = await mkdtemp(join(tmpdir(), 'happier-mi2-open-'));
    roots.push(root);
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes });
    const rows: ProjectAccountRowV1[] = [];
    // Same canonical private projection fixture as registerProjectOpenRpcHandlers.test.ts;
    // the mocked boundary is authenticated Home HTTP, not Workspace/SCM logic.
    const authorization = { v: 1, token: 'admitted-requester-fixture', binding: {
      accountId, custodianAccountId: 'owner', serverIdentityId: 'srv_test_home', machineId: 'machine',
      installationId: 'installation', actionId: 'projects.open', accountEncryptionMode: 'plain',
      authentication: { kind: 'terminal', tokenEpoch: 0 }, requestId: `request-${accountId}`,
      requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
    }, requesterAccountProjection: {
      accountId, serverId: 'srv_test_home', accountEncryptionMode: 'plain', projectAccountRowCipher: cipher,
      projectTrustRowCipher: createProjectSetupTrustRowCipher({ mode: 'plain', material: null }),
      resolveMachineContentEncryptionContext: () => ({ encryptionMode: 'plain' as const }),
      isCurrent: async () => true, readArtifact: async () => null,
    }, requesterHttpProjection: {
      accountId, serverId: 'srv_test_home', serverIdentityId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example',
      accountEncryptionMode: 'plain', isCurrent: async () => true,
      createRequestHeaders: async () => ({ 'x-requester-proof': accountId }),
    } } satisfies ExternalActionExecutionAuthorizationV1;
    vi.spyOn(axios, 'get').mockImplementation(async url => url.includes('/v1/machines/')
      ? { status: 200, data: { machine: { id: 'machine', active: true, installationId: 'installation', storageMode: 'plain',
        metadataVersion: 1, daemonStateVersion: 0, daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: encodePlainMachineStoredContent({ host: 'machine', platform: 'linux', homeDir: '/home/user',
          happyCliVersion: 'test', happyHomeDir: '/home/user/.happier' }) } } }
      : { status: 200, data: { mode: 'plain', updatedAt: 0 } });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      expect(config?.headers).toMatchObject({ 'x-requester-proof': accountId });
      if (url.endsWith('/project-trust/read')) return { status: 200, data: { status: 'absent' } };
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      if (url.endsWith('/read')) return projectAccountRowReadResponse(rows, body);
      const mutation = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changed = mutation.mutations.map(item => ({ key: item.key, revision: 0, content: item.content }));
      rows.push(...changed);
      return { status: 200, data: { status: 'updated', cursor: 1, rows: changed } };
    });
    let admissionChecks = 0;
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: scenario === 'owner-automation' ? 'account_automation' : 'present_user',
      callerInputAuthorization: authorization,
      machineAdmission: { actorAccountId: accountId, custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: accountId === 'owner' ? 'manage' : 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => { admissionChecks++; return scenario !== 'owner-admitted-once' || admissionChecks === 1; } };
    expect(selectHostRequesterExecutionIdentity({ rpcContext: context, hostHomeServerIdentityId: 'srv_test_home' }))
      .toMatchObject(scenario === 'owner-automation' ? { kind: 'isolated', separationRequired: false, accountAutomation: true, requester: { accountId } }
        : accountId === 'owner' ? { kind: 'owner_person', requester: { accountId } }
        : { kind: 'isolated', separationRequired: true, requester: { accountId } });
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => {
      // RPC transport accepts unknown JSON; registered schemas own validation.
      handlers.set(method, handler as RpcHandler<unknown, unknown>);
    } };
    registerProjectOpenRpcHandlers(registrar, { serverId: 'srv_test_home', machineId: 'machine', runtime: {
      serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'owner',
      readCredentials: async () => { throw new Error('Member must not read custodian credentials'); },
    } });
    const handler = handlers.get(RPC_METHODS.PROJECTS_OPEN);
    if (!handler) throw new Error('Production Project Open registration missing');
    const diagnostic = vi.spyOn(logger, 'warnLocalFile');
    const result = await handler({ serverId: 'srv_test_home', machineId: 'machine',
      source: { kind: 'folder', path: root }, materialization: { kind: 'attach' } }, context);
    if (accountId === 'owner') {
      expect(result).toMatchObject({ kind: 'opened', directory: root, setup: 'notRequired' });
      expect(rows.filter(row => row.key.kind === 'workspace-ref')).toHaveLength(1);
      expect(admissionChecks).toBe(1);
    } else {
      expect(result).toEqual({ kind: 'refused', code: 'workspace_private_checkout_required', effectAttempted: false,
      remediation: { kind: 'confirmation_required', action: 'projects.open', label: expect.any(String) } });
      expect(post.mock.calls.some(([url]) => url.endsWith('/mutate'))).toBe(false);
      expect(rows).toEqual([]);
      expect(diagnostic.mock.calls).toEqual(expect.arrayContaining([[ '[Project Open] Refused',
        { code: 'workspace_private_checkout_required', reason: 'workspace_private_checkout_required', phase: 'native_execution_admission' } ]]));
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(root);
    }
  });
});

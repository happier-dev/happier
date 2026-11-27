import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AccountSettingsSchema,
  buildConnectedServiceCredentialRecord,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { resolveSessionConnectedServiceSwitchContinuity } from '@/daemon/startDaemon';
import { resolveConnectedServiceHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { materializeSessionConnectedServiceRuntimeAuthSelection } from '@/daemon/connectedServices/sessionAuthSwitch/materializeSessionConnectedServiceRuntimeAuthSelection';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from '@/daemon/connectedServices/sessionAuthSwitch/resolveTrackedConnectedServiceSwitchContinuityContext';
import { writeConnectedServiceStateSharingManifest } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import { withTempDir } from '@/testkit/fs/tempDir';

const CONVERSATION_ID = '6f942a45-0018-47f8-9d82-9f9ec0fa9780';

/**
 * A machine-login (native) agy session switched to an Antigravity pool with shared state must be
 * proven against the member home the next launch uses, after that home is materialized.
 */
describe('Antigravity native session switched to a connected-service pool', () => {
  it('rematerializes a stale pinned-layout member home and proves the shared conversation', async () => {
    await withTempDir('agy-pool-switch-', async (root) => {
      const activeServerDir = join(root, 'server');
      const nativeHome = join(root, 'native-gemini');
      const project = join(root, 'project');
      await mkdir(project, { recursive: true });
      const nativeConversations = join(nativeHome, 'antigravity-cli', 'conversations');
      await mkdir(nativeConversations, { recursive: true });
      await writeFile(join(nativeConversations, `${CONVERSATION_ID}.db`), 'native-conversation');

      // A member home last materialized for the retired pinned server: no CLI store, shared manifest.
      const memberHome = resolveConnectedServiceHomeDir({ activeServerDir, serviceId: 'antigravity', profileId: 'lbservers', agentId: 'agy' });
      await mkdir(join(memberHome, 'antigravity-acp', 'conversations'), { recursive: true });
      await writeConnectedServiceStateSharingManifest(memberHome, {
        v: 1, requestedStateMode: 'shared', effectiveStateMode: 'shared', lastSyncAtMs: 1,
        configEntries: [], stateEntries: [], sessionFileMappings: [], diagnostics: [],
      });

      const record = buildConnectedServiceCredentialRecord({
        now: 1_000, serviceId: 'antigravity', profileId: 'lbservers', kind: 'oauth', expiresAt: 2_000_000_000_000,
        oauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: null, scope: null, tokenType: 'Bearer',
          providerAccountId: 'fixture-account', providerEmail: 'lb@example.test' },
      });
      const credentialRevision = 'csr_abcdefghijklmnopqrstuv';
      // Server boundary: credential and pool reads.
      const api = {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getConnectedServiceCredentialPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: record }, revisionSemantics: 'revisioned' as const, credentialRevision,
        })),
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
        getConnectedServiceAuthGroup: vi.fn(async () => ({ groupId: 'pool', activeProfileId: 'lbservers', generation: 3 })),
      };
      const credentials: Credentials = { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
      const accountSettings = AccountSettingsSchema.parse({
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'shared' }, byAgentId: {},
        },
      });
      const previousBindings: ConnectedServiceBindingsV1 = { v: 1, bindingsByServiceId: {} };
      const normalizedBindings: ConnectedServiceBindingsV1 = {
        v: 1, bindingsByServiceId: { antigravity: { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'lbservers' } },
      };
      const previous = { source: 'native', selection: 'native', serviceId: 'antigravity', profileId: null, groupId: null } as const;
      const next = { source: 'connected', selection: 'group', serviceId: 'antigravity', profileId: 'lbservers', groupId: 'pool' } as const;
      const identity = { v: 1 as const, id: 'csm_agy_pool', createdAtMs: 1_000 };

      const runtimeAuthSelection = await materializeSessionConnectedServiceRuntimeAuthSelection({
        credentials, api: api as unknown as ApiClient, activeServerDir, accountSettings,
        processEnv: { HOME: root, GEMINI_HOME: nativeHome },
        input: {
          mode: 'apply', tracked: null, cwd: project, sessionId: 'session-agy', agentId: 'agy', serviceId: 'antigravity',
          previous, next, previousBindings, normalizedBindings,
          groupMetadata: { groupId: 'pool', activeProfileId: 'lbservers', fallbackProfileId: 'lbservers', generation: 3 },
        },
      });
      const context = resolveTrackedConnectedServiceSwitchContinuityContext({
        agentId: 'agy', baseDir: join(root, 'materialized'), tracked: null,
        connectedServiceMaterializationIdentityV1: identity, vendorResumeId: CONVERSATION_ID, cwd: project,
        runtimeAuthSelection,
      });

      expect(context.targetMaterializedRoot).toBe(memberHome);
      await expect(resolveSessionConnectedServiceSwitchContinuity({
        sessionId: 'session-agy', agentId: 'agy', serviceId: 'antigravity',
        previousBinding: previous, nextBinding: next, fromBindingsRaw: previousBindings, toBindings: normalizedBindings,
        accountSettings, connectedServiceMaterializationIdentityV1: identity, vendorResumeId: context.vendorResumeId,
        targetMaterializedRoot: context.targetMaterializedRoot, targetMaterializedEnv: context.targetMaterializedEnv,
        cwd: context.cwd, candidatePersistedSessionFile: context.candidatePersistedSessionFile, runtimeAuthSelection,
      })).resolves.toMatchObject({ mode: 'restart_rematerialize', diagnostics: { effectiveStateMode: 'shared' } });

      // The stale member home now carries the native CLI layout linked to the machine store.
      const linkedConversations = join(memberHome, 'antigravity-cli', 'conversations');
      expect((await lstat(linkedConversations)).isSymbolicLink()).toBe(true);
      expect(await realpath(linkedConversations)).toBe(await realpath(nativeConversations));
      expect(await readFile(join(memberHome, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).toContain('fixture-refresh');
    });
  });
});

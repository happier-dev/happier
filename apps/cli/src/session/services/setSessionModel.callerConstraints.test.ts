import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
  V2SessionRecordSchema,
  SessionMetadataInactiveModelIntentOwnerPatchV1Schema,
  type V2SessionRecord,
  ActionsSettingsV1Schema,
  isApprovalRequiredByActionsSettings,
} from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SessionModelMutationReversalV1Schema } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { setSessionModel } from './setSessionModel';
import { setSessionPermissionMode } from './setSessionPermissionMode';
import { readAccountSettingsV2Raw } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';

const network = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
// Only HTTP is replaced; Session resolution, envelope parsing and metadata CAS stay real.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, ...network } };
});

const sessionId = 'c123456789012345678901234';
const modelA = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'A' };
const metadata = SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: { flavor: 'codex' } });
const session = V2SessionRecordSchema.parse({
  id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
  encryptionMode: 'plain', metadataVersion: 1, metadataLayoutVersion: 1,
  dataEncryptionKey: null, share: null,
  agentState: null, agentStateVersion: 1,
  metadata: JSON.stringify({ v: 1, agentPresentation: { agentId: 'codex' } }),
  ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(metadata),
});

describe('setSessionModel caller constraints at the effective selection boundary', () => {
  beforeEach(() => {
    network.get.mockReset();
    network.patch.mockReset();
    network.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session } };
      throw new Error(`Unexpected GET ${url}`);
    });
    network.patch.mockResolvedValue({ status: 200, data: {
      success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 2 },
    } });
  });

  it('captures and conditionally restores model intent through the public Action and real metadata HTTP CAS', async () => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`, encryption: null };
    const storedAccountSettings = { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'session.model.set': ['cli'] } }) };
    let current: V2SessionRecord = { ...session, ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({
      ...metadata, runtime: { modelSelectionIntentV1: { v: 1, updatedAt: 10, selection: modelA } },
    })) };
    network.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: storedAccountSettings }, version: 1 } };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: current } };
      throw new Error(`Unexpected GET ${url}`);
    });
    network.patch.mockImplementation(async (_url, body) => {
      const patch = SessionMetadataInactiveModelIntentOwnerPatchV1Schema.parse(body);
      expect(patch.expectedOwnerMetadata).toEqual(current.ownerMetadata);
      current = { ...current, ownerMetadata: patch.ownerMetadata, metadata: patch.sharedMetadata.ciphertext,
        metadataVersion: current.metadataVersion + 1, agentState: patch.agentState.ciphertext,
        agentStateVersion: current.agentStateVersion + 1 };
      return { status: 200, data: { success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: current.metadataVersion }, agentState: { version: current.agentStateVersion } } };
    });
    await runWithServerHttpBaseUrl('https://home.example.test', async () => {
      const account = await readAccountSettingsV2Raw({ credentials });
      const actionsSettings = ActionsSettingsV1Schema.parse(account.raw.actionsSettingsV1);
      const deps = createCliActionDeps({ credentials, token: credentials.token,
        serverId: 'home', serverHttpBaseUrl: 'https://home.example.test', sessionId, mode: 'plain', ctx: null });
      const executor = createActionExecutor({ ...deps,
        isActionApprovalRequired: (actionId, context, input) => isApprovalRequiredByActionsSettings(actionId, actionsSettings, context,
          undefined, undefined, input) });
      const context = { surface: 'cli', authority: 'present_user', serverId: 'home', actionCaller: { kind: 'host' }, actionsSettings } as const;
      const applied = await executor.execute('session.model.set', { sessionId, modelId: 'B', providerConnectionId: null, captureBefore: true }, context);
      expect(applied.ok).toBe(true);
      if (!applied.ok) throw new Error(applied.error);
      const result = applied.result as { reversal: unknown };
      const reversal = SessionModelMutationReversalV1Schema.parse(result.reversal);
      const scope = { serverId: 'home', accountId: 'account-1', sessionId };
      expect(reversal).toMatchObject({ owner: 'inactive', scope, before: modelA, applied: { ...modelA, modelId: 'B' } });
      const undo = { sessionId, modelId: reversal.before.modelId, providerConnectionId: reversal.before.providerConnectionId,
        expected: { owner: 'inactive', scope, selection: reversal.applied, updatedAt: reversal.updatedAt } };
      const beforeForeignReceipt = current;
      expect(await executor.execute('session.model.set', { ...undo,
        expected: { ...undo.expected, scope: { ...scope, serverId: 'other-home' } } }, context))
        .toMatchObject({ ok: false, errorCode: 'superseded' });
      expect(current).toBe(beforeForeignReceipt);
      expect(await executor.execute('session.model.set', undo, context)).toMatchObject({ ok: true });
      expect(current.ownerMetadata).toMatchObject({ t: 'plain', v: { runtime: { modelSelectionIntentV1: { selection: modelA } } } });
      await executor.execute('session.model.set', { sessionId, modelId: 'C', providerConnectionId: null }, context);
      const beforeRefusal = current;
      expect(await executor.execute('session.model.set', undo, context)).toMatchObject({ ok: false, errorCode: 'superseded' });
      expect(current).toBe(beforeRefusal);
    });
  });

  it('refuses a restricted mode before metadata mutation and preserves an unrestricted caller', async () => {
    await runWithServerHttpBaseUrl('https://home.example.test', async () => {
      const input = { credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId, permissionMode: 'yolo' as const };
      await expect(setSessionPermissionMode({ ...input, callerInputConstraints: { models: null, permissionModes: ['default'] } }))
        .resolves.toMatchObject({ ok: false, code: 'permission_mode_not_granted' });
      expect(network.patch).not.toHaveBeenCalled();
      await expect(setSessionPermissionMode(input)).resolves.toMatchObject({ ok: true });
    });
  });

  it.each(['native', 'team resource'] as const)('refuses a restricted %s ref but preserves an unrestricted caller in the same Session', async (kind) => {
    const modelInput = kind === 'native'
      ? { modelId: 'B', providerConnectionId: null }
      : { teamCredentialModel: {
          kind: 'team_credential_provider_model' as const, teamId: 'team-1', resourceId: 'resource-1',
          expectedResourceRevision: 7, deliveryMode: 'brokered' as const,
          agentTargetKey: modelA.agentTargetKey, modelId: 'B',
        } };
    const input = { credentials: { token: 'account-token', encryption: null }, idOrPrefix: sessionId, ...modelInput };
    await runWithServerHttpBaseUrl('https://home.example.test', async () => {
      await expect(setSessionModel({ ...input, callerInputConstraints: { models: [modelA], permissionModes: null } }))
        .resolves.toMatchObject({ ok: false, code: 'model_not_granted' });
      expect(network.patch).not.toHaveBeenCalled();
      await expect(setSessionModel(input)).resolves.toMatchObject({ ok: true, status: 'intent_updated' });
    });
  });
});

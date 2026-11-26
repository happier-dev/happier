import axios from 'axios';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createLightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { accountRoutes } from '../../../../../server/sources/app/api/routes/account/accountRoutes';
import { artifactsRoutes } from '../../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { sessionRoutes } from '../../../../../server/sources/app/api/routes/session/sessionRoutes';
import { sessionPendingRoutes } from '../../../../../server/sources/app/api/routes/session/pendingRoutes';
import { registerAutomationActionIndexRoutes } from '../../../../../server/sources/app/api/routes/automations/registerAutomationActionIndexRoutes';
import { featuresRoutes } from '../../../../../server/sources/app/api/routes/features/featuresRoutes';
import { registerPluginAvailabilityRoutes } from '../../../../../server/sources/app/plugins/availability/routes';
import { registerAccountSecurityRoutes } from '../../../../../server/sources/app/api/routes/auth/registerAccountSecurityRoutes';
import { initializeServerIdentityCache } from '../../../../../server/sources/app/serverIdentity/serverIdentity';
import { auth } from '../../../../../server/sources/app/auth/auth';
import { db } from '../../../../../server/sources/storage/db';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { configuration, reloadConfiguration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliActionDeps } from '../createCliActionDeps';
import { createCliActionExecutorFromCredentials } from '../createCliActionExecutorFromCredentials';
import { createDeferredOutcomeDeliveryBoundary } from './deferredOutcomeDelivery.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { skillFileFromBytesV1 } from '@happier-dev/protocol/prompts/library/skills/skillZipV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, buildPromptLibraryPhysicalKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

// Real authenticated HTTP, SQLite, CLI composition, approval Artifacts, rule CAS
// and Session metadata writes. No internal domain service is substituted.
// A different client replays the Session's durable approval intent.
describe('Session skill creation through durable approval replay', () => {
  let sqlite: Awaited<ReturnType<typeof createLightSqliteHarness>>;
  beforeAll(async () => {
    sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-d26-replay-', initAuth: true, initEncrypt: true,
      env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
  }, 0);
  afterAll(async () => { if (sqlite) await sqlite.close(); });

  it.each(['approved', 'waived', 'explicit', 'rules'] as const)('retains creating Session intent for %s install', async mode => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    const app = createAuthenticatedTestApp({ authentication: 'real' }) as import('../../../../../server/sources/app/api/types').Fastify;
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    try {
      const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 1 } });
      const machineId = `machine-${mode}`;
      const serverIdentityId = await initializeServerIdentityCache();
      if (!serverIdentityId) throw new Error('Missing Home identity');
      const machine = await db.machine.create({ data: { id: machineId, accountId: account.id, installationId: `installation-${mode}`,
        metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
      for (const key of PromptLibraryCatalogKeyV1Schema.options) await db.userKVStore.create({ data: {
        accountId: account.id, key: buildPromptLibraryPhysicalKeyV1(key), version: 1,
        value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: emptyPromptLibraryRecordV1(key) })),
      } });
      const seedMetadata = createTestMetadata({ machineId, path: '/project',
        agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: 'supported', skillsLiveReload: 'supported' } } });
      const owner = createSessionOwnerMetadataV1({ metadata: seedMetadata });
      if (!owner.ok) throw new Error('Invalid canonical Session fixture');
      const session = await db.session.create({ data: { accountId: account.id, tag: `d26-${mode}`, encryptionMode: 'plain', active: true,
        metadataLayoutVersion: 1, metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: seedMetadata })),
        ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata)) } });
      await db.accessKey.create({ data: { accountId: account.id, sessionId: session.id, machineId, data: 'opaque' } });
      await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: { homeId: serverIdentityId,
        accountId: account.id, sessionId: session.id, machineId, installationId: machine.installationId! } } });
      const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' }),
        credentialProvenance: 'stored_session' as const, encryption: null };
      accountRoutes(app); artifactsRoutes(app); sessionRoutes(app); registerPluginAvailabilityRoutes(app); registerAccountSecurityRoutes(app);
      sessionPendingRoutes(app); registerAutomationActionIndexRoutes(app);
      featuresRoutes(app);
      const url = await app.listen({ port: 0, host: '127.0.0.1' });
      env.patch({ HAPPIER_HOME_DIR: `${sqlite.baseDir}/${mode}`, HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url });
      reloadConfiguration(); resetInMemoryAccountSettingsContextForTests();
      runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
        runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
      await runWithServerHttpBaseUrl(url, async () => {
        await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
        const origin = mode === 'approved' || mode === 'explicit'
          ? await createDeferredOutcomeDeliveryBoundary({ accountId: account.id, serverId: configuration.activeServerId, serverIdentityId,
              machineId, sessionId: session.id, sessionCrypto: { mode: 'plain', ctx: null },
              callerAuthority: 'account_automation', readReceiver: () => executor }) : null;
        if (origin) {
          onTestFinished(() => origin.close());
          const get = axios.get.bind(axios);
          const http = vi.spyOn(axios, 'get').mockImplementation(async (requestUrl, options) => {
            const path = new URL(String(requestUrl)).pathname;
            if (path === `/v1/machines/${machineId}`) return { status: 200, data: { machine: origin.machine } };
            const prefix = `/v2/sessions/${session.id}/messages/by-local-id/`;
            if (path.startsWith(prefix)) {
              const message = origin.readMessage(decodeURIComponent(path.slice(prefix.length)));
              if (message) return { status: 200, data: { message } };
              throw Object.assign(new axios.AxiosError('Message not found'), { response: { status: 404, data: { error: 'Message not found' } } });
            }
            return await get(requestUrl, options);
          });
          onTestFinished(() => http.mockRestore());
        }
        const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: session.id, mode: 'plain', ctx: null,
          serverHttpBaseUrl: url });
        const executor = createActionExecutor(deps);
        const pending = executor.execute('skills.install', { source: { kind: 'upload', files: [
          skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('---\nname: replay-skill\n---\nA harmless fixture.'), 0o644),
        ] }, ...(mode === 'explicit' ? { where: { kind: 'write', write: { place: { t: 'machine', machineId: 'chosen-machine' }, state: 'on' } } } : {}) }, {
          surface: 'mcp', authority: 'account_automation', serverId: deps.skillRules!.serverId, serverIdentityId, runtimeAccountId: account.id,
          defaultSessionId: session.id, ...(origin ? { defaultSessionMachineId: machineId } : {}), actionRequestId: `d26-${mode}`,
          ...(mode === 'waived' || mode === 'rules' ? { actionsSettings: {
            v: 1 as const, actions: {}, approvalWaivedSurfaces: { 'skills.install': ['agent' as const] },
          } } : {}),
          actionCaller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
        });
        if (mode === 'waived' || mode === 'rules') {
          const proposed = await pending;
          expect(proposed.ok, proposed.ok ? undefined : proposed.errorCode).toBe(true);
          if (!proposed.ok) throw new Error(`Install refused: ${proposed.errorCode}`);
          const receipt = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(proposed.result);
          if (!('skillIds' in receipt)) throw new Error('Missing install receipt');
          expect(receipt.incomplete).toBeUndefined();
        } else {
          expect(await pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
          const inventory = await db.artifact.findMany({ where: { accountId: account.id }, select: { id: true } });
          const artifactId = inventory[0]?.id;
          if (!artifactId) throw new Error('Missing approval Artifact');
          expect(ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId })).executionOriginV1)
            .toMatchObject({ caller: { kind: 'session', sessionId: session.id } });
          const decidingExecutor = createCliActionExecutorFromCredentials({ credentials, serverId: configuration.activeServerId,
            serverApiUrl: url, serverIdentityId, readCredentials: async () => credentials });
          const decided = await decidingExecutor.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
            surface: 'cli', authority: 'present_user', serverId: deps.skillRules!.serverId, runtimeAccountId: account.id,
            actionCaller: { kind: 'host' },
          });
          const settled = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId }));
          if (!decided.ok) throw new Error(`Decision refused: ${decided.errorCode}`);
          expect(decided, settled.execution?.errorCode).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
          if (!origin) throw new Error('Missing origin delivery boundary');
          const deliveries = await db.sessionPendingMessage.findMany({ where: { sessionId: session.id }, select: { localId: true } });
          expect(deliveries,
            JSON.stringify({ decided, settled, deliveries, replays: origin.replayArtifacts }))
            .toEqual([{ localId: `approval-result:${artifactId}` }]);
          expect(origin.replayArtifacts).toEqual([{ artifactId }]);
        }
        const listed = await executor.execute('skills.list', {}, { surface: 'ui', authority: 'present_user' });
        if (!listed.ok) throw new Error(`Library read refused: ${listed.errorCode}`);
        const items = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(listed.result).items.filter(item => item.name === 'replay-skill');
        expect(items).toHaveLength(1);
        const item = items[0]!;
        if (mode === 'rules') {
          const rulesExecutor = createActionExecutor(deps);
          const rulesPending = rulesExecutor.execute('skills.rules.set', {
            items: [{ skillId: item.skillId }],
            change: { kind: 'write', write: { place: { t: 'machine', machineId: 'chosen-machine' }, state: 'on' } },
          }, { surface: 'mcp', authority: 'account_automation', serverId: deps.skillRules!.serverId,
            serverIdentityId, runtimeAccountId: account.id, defaultSessionId: session.id,
            actionRequestId: 'rules-receipt', actionCaller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 } });
          const proposed = await rulesPending;
          expect(proposed).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
          if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object'
            || !('artifactId' in proposed.result) || typeof proposed.result.artifactId !== 'string') throw new Error('Missing rules approval');
          const rulesArtifactId = proposed.result.artifactId;
          const decidingExecutor = createCliActionExecutorFromCredentials({ credentials, serverId: configuration.activeServerId,
            serverApiUrl: url, serverIdentityId, readCredentials: async () => credentials });
          const decided = await decidingExecutor.execute('approval.request.decide', { artifactId: rulesArtifactId, decision: 'approve' }, {
            surface: 'cli', authority: 'present_user', serverId: deps.skillRules!.serverId, runtimeAccountId: account.id,
            actionCaller: { kind: 'host' },
          });
          const settled = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId: rulesArtifactId }));
          expect(decided).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
          expect(settled).toMatchObject({ status: 'executed', execution: { ok: true } });
          const updated = await executor.execute('skills.list', {}, { surface: 'ui', authority: 'present_user' });
          if (!updated.ok) throw new Error(updated.errorCode);
          expect(SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(updated.result).items.find(row => row.skillId === item.skillId)?.rules)
            .toEqual([expect.objectContaining({ target: { t: 'machine', machineId: 'chosen-machine' }, enabled: true })]);
          // Public observation keeps the projected receipt rather than previous rules.
          const observed = await decidingExecutor.execute('approval.request.get', { artifactId: rulesArtifactId }, {
            surface: 'cli', authority: 'present_user', serverId: deps.skillRules!.serverId, runtimeAccountId: account.id,
            actionCaller: { kind: 'host' },
          });
          expect(observed).toMatchObject({ ok: true, result: { request: { execution: { result: {
            ok: true, itemIds: [item.skillId],
          } } } } });
          expect(JSON.stringify(observed)).not.toContain('previous');
        }
        const raw = await fetchSessionById({ reason: 'session-action', token: credentials.token, sessionId: session.id });
        if (!raw) throw new Error('Missing Session');
        const metadata = tryDecryptSessionOwnerMetadataView({ credentials, accountEncryptionMode: 'plain', rawSession: raw });
        const selection = readSessionCapabilitySelectionFromMetadataV1(metadata);
        if (mode === 'explicit') {
          expect(item?.rules).toEqual([expect.objectContaining({ target: { t: 'machine', machineId: 'chosen-machine' }, enabled: true })]);
          expect(selection.skills.forceIncludeSkillIds).toEqual([]);
        } else {
          expect(item?.rules).toEqual([]);
          expect(selection.skills.forceIncludeSkillIds).toEqual([item.skillId]);
        }
      });
    } finally {
      await runtime?.dispose(); await app.close(); env.restore(); reloadConfiguration(); resetInMemoryAccountSettingsContextForTests();
    }
  });
});

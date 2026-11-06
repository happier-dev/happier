import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import axios from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2HistoryMutationRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ACP_CATALOG_ROWS_ROUTE_V1, type AcpCatalogRecordV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';
import { createCliActionDeps } from '../createCliActionDeps';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { buildAgentBackendInventoryItems } from '../inventory/buildAgentBackendInventoryItems';
import { buildReviewEngineInventoryItems } from '../inventory/buildReviewEngineInventoryItems';
import { ScmDiffSummaryModelCatalogObservationV1Schema } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createCliMachineInventoryActionDeps } from './machineInventory';
import { createCapabilitiesService } from '@/capabilities/service';
import { createAcpAgentInventoryCapability } from '@/capabilities/registry/machineAgentsInventory';
import type { CapabilitiesDetectRequest } from '@/capabilities/types';

const record = { v: 1, definitions: [{ id: 'row-review', name: 'row-review', title: 'Row Review', launch: { kind: 'command' as const, command: 'review-agent', args: ['acp'] },
   env: {}, capabilities: { supportsLoadSession: true, supportsModes: 'yes', supportsModels: 'yes',
    supportsConfigOptions: 'unknown', promptImageSupport: 'no' }, createdAt: 1, updatedAt: 2 }] } satisfies AcpCatalogRecordV1;
const privateDefinitionRecord = { v: 1, definitions: [{ ...record.definitions[0],
  env: { CONFIG: { t: 'literal', v: 'private-config' }, TOKEN: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1('private-get-resource') } },
  auth: { support: 'login_terminal', loginCommand: { command: 'private-login-command', args: ['--private-auth-config'] }, envVars: ['TOKEN'] },
  defaultMode: 'private-mode', defaultModel: 'private-model',
}] } satisfies AcpCatalogRecordV1;
const servers: Server[] = [];
const targetKey = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'row-review', configuredBackendId: 'row-review', sourceKind: 'configured' });
afterEach(async () => {
  resetActiveAccountSettingsSnapshotForTests();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
});

async function createInventory(status: 'ready' | 'partial' | 'unavailable' = 'ready', options: Readonly<{
  retireOnRead?: boolean; retireOnWrite?: boolean;
  initialRevision?: number;
  initialRecord?: AcpCatalogRecordV1;
  history?: 'complete' | 'unavailable';
  initialRowAbsent?: boolean;
  interleaveOnHistoryRead?: boolean;
  admitPurposes?: boolean;
}> = {}) {
  const requests: string[] = [];
  const writes: unknown[] = [];
  const historyWrites: unknown[] = [];
  let historySettings: Record<string, unknown> = { neighboringRoot: { keep: true }, acpCatalogSettingsV1: { v: 2, backends: record.definitions } };
  let currentRecord: AcpCatalogRecordV1 = options.initialRecord ?? record;
  let revision = options.initialRowAbsent ? -1 : options.initialRevision ?? 4;
  let current = true;
  let interleaved = false;
  let purposeStatus: 'ready' | 'unavailable' | 'absent' = 'ready';
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    expect(request.headers.authorization, request.url).toBe('Bearer requester-acp');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/account/encryption/currentness') {
      response.end(JSON.stringify({ mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    } else if (options.admitPurposes && request.url === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) {
      if (purposeStatus === 'unavailable') { response.statusCode = 503; response.end('{}'); }
      else response.end(JSON.stringify(purposeStatus === 'absent' ? { status: 'absent' } : {
        status: 'present', revision: 1, content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1('purposes') },
      }));
    } else if (request.url === ACP_CATALOG_ROWS_ROUTE_V1) {
      if (request.method === 'POST') {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => { body += chunk; });
        request.on('end', () => {
          const mutation = JSON.parse(body) as { content: { t: 'plain'; v: AcpCatalogRecordV1 } };
          writes.push(mutation);
          currentRecord = mutation.content.v;
          revision += 1;
          if (options.retireOnWrite) current = false;
          response.end(JSON.stringify({ status: 'updated', revision, cursor: revision }));
        });
        return;
      }
      if (options.retireOnRead) current = false;
      if (status === 'unavailable') { response.statusCode = 403; response.end(JSON.stringify({ error: 'forbidden' })); }
      else response.end(JSON.stringify(revision < 0 ? { status: 'absent' } : { status: 'present', revision, content: { t: 'plain', v: status === 'partial'
        ? { ...currentRecord, definitions: [...currentRecord.definitions, { id: 'invalid' }] } : currentRecord } }));
    } else if (options.initialRowAbsent && request.url === '/v2/account/settings') {
      response.end(JSON.stringify({ version: 7, content: { t: 'plain', v: {
        neighboringRoot: { keep: true }, acpCatalogSettingsV1: { v: 2, backends: record.definitions },
      } } }));
    } else if (options.history && request.url === '/v2/account/settings/history') {
      if (options.interleaveOnHistoryRead && !interleaved) {
        interleaved = true;
        currentRecord = { v: 1, definitions: [{ ...record.definitions[0], title: 'Later writer' }] };
        revision += 1;
      }
      response.end(JSON.stringify({ snapshots: [{ version: 7, contentKind: 'plain', byteLength: 100, createdAt: '2026-10-09T00:00:00.000Z' }] }));
    } else if (options.history && request.url === '/v2/account/settings/history/7') {
      response.end(JSON.stringify({ version: 7, content: { t: 'plain', v: historySettings }, createdAt: '2026-10-09T00:00:00.000Z' }));
    } else if (options.history && request.url === '/v2/account/settings/history/7/mutate' && request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse(JSON.parse(body));
        historyWrites.push(mutation);
        if (options.history === 'unavailable') { response.statusCode = 503; response.end('{}'); return; }
        if (mutation.operation.kind !== 'normalize' || mutation.operation.content?.t !== 'plain') throw new Error('Expected plain history normalization');
        historySettings = mutation.operation.content.v;
        response.end(JSON.stringify({ status: 'applied' }));
      });
    } else if (options.history && request.url?.startsWith('/v1/account/entity-rows/') && request.url !== '/v1/account/entity-rows/prompt-library') {
      response.end(JSON.stringify({ status: 'absent' }));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  const credentials = { token: 'requester-acp', encryption: null } as const;
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 99,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey({ token: 'daemon-acp', encryption: null }) });
  const incumbent = getActiveAccountSettingsSnapshot();
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials,
    serverHttpBaseUrl: `http://127.0.0.1:${address.port}`, isCurrent: async () => current,
    snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) } });
  const deps = createCliActionInventoryDeps({ token: credentials.token, credentials, savedSecretOperationContext: operationContext,
    sessionId: 'requester-session', mode: 'plain', ctx: null, rawSession: { metadata: { sessionModelsV1: {
      provider: 'customAcp', availableModels: [{ id: 'stale-model', name: 'Stale model' }] } } } });
  return { deps, requests, writes, historyWrites, incumbent, operationContext, credentials,
    setPurposeStatus: (status: typeof purposeStatus) => { purposeStatus = status; },
    readRow: () => ({ record: currentRecord, revision }), readHistory: () => historySettings };
}

describe('ACP Action inventory row authority', () => {
  it.each(['guest', 'custodian'] as const)('keeps the host Account ACP catalog private for an admitted %s list', async actor => {
    const hostRecord = { v: 1, definitions: [{ ...record.definitions[0], id: 'host-only', title: 'Host private Agent',
      launch: { kind: 'command', command: process.execPath, args: ['--host-private-config'] },
    }] } satisfies AcpCatalogRecordV1;
    const { deps, credentials, requests } = await createInventory('ready', { initialRecord: hostRecord });
    const service = createCapabilitiesService({ capabilities: [createAcpAgentInventoryCapability({ accountId: 'custodian' })],
      checklists: { 'machine-details': [], 'new-session': [] }, buildContext: async () => ({ cliSnapshot: null }) });
    const nativeFacts = { installed: true, version: '1.0', latestVersion: null,
      update: { supported: false, command: null }, signIn: { status: 'signedOut', loginSupport: 'unsupported' },
      platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] };
    // Machine RPC is the boundary; Account catalog admission, Action execution,
    // definition projection and the registered ACP capability all remain real.
    const machineDeps = createCliMachineInventoryActionDeps({ credentials }, {
      inventoryDeps: deps, callMachineAction: async input => {
        if (input.method === 'daemon.extensions.contributionRegistryProjection.describe') {
          return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
            'acme/helper': { id: 'helper', title: 'Remote Helper', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
          } } };
        }
        if (input.method !== 'capabilities.detect') throw new Error('Unexpected Machine RPC');
        const response = await service.detect(input.request as CapabilitiesDetectRequest);
        return { ...response, results: { ...response.results,
          'cli.acme/helper': { ok: true, checkedAt: 1, data: nativeFacts },
        } };
      },
    });
    const executor = createActionExecutor({ ...deps, ...machineDeps });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-admission', binding: {
      accountId: actor, custodianAccountId: 'custodian', authentication: { kind: 'account', tokenEpoch: 0 },
      accountEncryptionMode: 'plain', serverIdentityId: 'home', actionId: 'machines.agents.list', requestId: 'list',
      machineId: 'machine', installationId: 'installation', target: { kind: 'machine', machineId: 'machine' },
      requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const context = { surface: 'cli' as const, authority: 'account_automation' as const,
      externalActionExecutionAuthorization: authorization };
    const result = await executor.execute('machines.agents.list', { machineId: 'machine' }, context);
    if (actor === 'guest') {
      expect(result).toEqual({ ok: true, result: {
        items: [{ agentId: 'acme/helper', title: 'Remote Helper', ...nativeFacts }],
        definitionCatalog: { status: 'unavailable', reason: 'requester-account-unavailable' },
      } });
      expect(requests).toEqual([]);
      // The guest's explicit executable-only draft remains usable on this root.
      const draft = await machineDeps.machinesAgentsList?.({ machineId: 'machine',
        draftDefinitions: [{ definitionId: 'guest-draft', title: 'Guest Agent',
          launch: { kind: 'command', command: process.execPath, args: [] } }],
      }, context);
      expect(draft).toMatchObject({ items: [{ definitionId: 'guest-draft', title: 'Guest Agent', installed: true }] });
      expect(requests).toEqual([]);
    } else {
      expect(result).toMatchObject({ ok: true, result: { items: [
        { agentId: 'acme/helper', title: 'Remote Helper', ...nativeFacts },
        { agentId: 'custom-acp', definitionId: 'host-only', title: 'Host private Agent', installed: true },
      ] } });
      expect(result).not.toHaveProperty('result.definitionCatalog');
      expect(requests).toContain(`GET ${ACP_CATALOG_ROWS_ROUTE_V1}`);
    }
  });
  it.each(['models', 'session_modes', 'summary'] as const)('returns native %s evidence only for an explicit configured probe in its requested workspace', async kind => {
    await withTempDir('happier-acp-action-probe-', async directory => {
      // Genuine executable boundary: the real ACP transport negotiates this
      // agent's session state; catalog admission, probing and Actions are real.
      const script = writeAcpTestAgentScript({ dir: directory, fileName: 'catalog-probe.mjs', source: `
        let buffer = '';
        const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
        process.stdin.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const request = JSON.parse(line);
            if (request.method === 'initialize') {
              reply(request.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
            } else if (request.method === 'session/new') {
              reply(request.id, {
                sessionId: 'catalog-probe-session',
                models: { currentModelId: 'agent-model', availableModels: [{
                  id: 'agent-model', name: 'Agent model', description: process.cwd(),
                  contextWindowTokens: 32000,
                  capabilities: { structuredOutput: 'supported' },
                  modelOptions: [{ id: 'reasoning', name: 'Reasoning', type: 'select', currentValue: 'private-current-value',
                    options: [{ value: 'private-current-value', name: 'Current reasoning' }] }],
                }] },
                modes: { currentModeId: 'agent-mode', availableModes: [{
                  id: 'agent-mode', name: 'Agent mode', description: process.cwd(),
                }] },
              });
            } else if (request.id !== undefined) {
              reply(request.id, {});
            }
          }
        });
      ` });
      const initialRecord = { v: 1, definitions: [{ ...record.definitions[0],
        launch: { kind: 'command', command: process.execPath, args: [script] },
      }] } satisfies AcpCatalogRecordV1;
      const { credentials, operationContext, requests, incumbent, setPurposeStatus } = await createInventory('ready', {
        initialRecord, admitPurposes: kind === 'summary',
      });
      if (kind === 'summary') {
        const snapshot = operationContext.readSnapshot();
        if (!snapshot) throw new Error('Requester snapshot retired');
        await operationContext.replaceAccountSettings({ ...snapshot, settingsVersion: snapshot.settingsVersion + 1, settings: accountSettingsParse({
          backendEnabledByTargetKey: Object.fromEntries([...readCurrentContributionRegistry().agentDefinitionsById.values()]
            .flatMap(entry => entry.identity ? listAgentExecutionTargetsV1(entry.identity).map(target => [buildBackendTargetKeyV2(target), false]) : [])),
        }) });
      }
      const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
        savedSecretOperationContext: operationContext, sessionId: 'requester-session', mode: 'plain', ctx: null,
        machineActionDirectTargetTransport: { machineId: 'configured-summary-machine', invoke: async () => { throw new Error('Unexpected recursion'); } } }));
      if (kind === 'summary') {
        const read = async (discover = false) => {
          const result = await executor.execute('agents.models.list', { purpose: 'scm_diff_summary', machineId: 'configured-summary-machine',
            ...(discover ? { discoveryTargetKey: targetKey } : {}) }, { surface: 'cli', authority: 'account_automation' });
          expect(result).toMatchObject({ ok: true });
          if (!result.ok || !result.result || typeof result.result !== 'object' || !('scmDiffSummaryCatalog' in result.result)) throw new Error('Missing catalog');
          return ScmDiffSummaryModelCatalogObservationV1Schema.parse(result.result.scmDiffSummaryCatalog);
        };
        const catalog = await read();
        expect(catalog.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ structuredOutput: 'unknown',
          modelSelector: { backendTargetKey: targetKey, modelId: 'agent-model' } })]));
        expect(catalog.automaticProfiles).toEqual([]);
        expect(catalog.discoveryTargetKeys).toContain(targetKey);
        expect.soft(requests).not.toContain('GET /v2/account/settings');
        // Runtime import follows the cross-App parity harness convention: the
        // pure picker consumer runs here without adding UI aliases to CLI compilation.
        const picker: { projectAgentModelChoices(input: Readonly<{ purpose: 'walkthrough'; sources: readonly unknown[];
          executableProfiles: typeof catalog.profiles; automaticProfiles: typeof catalog.automaticProfiles;
          discoveryTargetKeys: readonly string[]; defaultModelTitle: string }>): Readonly<{
            selections: Map<string, unknown>; defaultProfile: unknown; groups: readonly { discoverable: boolean }[];
          }> } = await import(new URL('../../../../../ui/sources/components/settings/pickers/projectAgentModelChoices.ts', import.meta.url).href);
        const project = (profiles: typeof catalog.profiles) => picker.projectAgentModelChoices({ purpose: 'walkthrough',
          sources: [{ entry: { kind: 'configuredBackend', backendTarget: targetKey, agentId: 'custom-acp', title: 'Row Review' },
            models: [], catalogModels: [], runnerCapable: true, discoverable: true }],
          executableProfiles: profiles, automaticProfiles: catalog.automaticProfiles, discoveryTargetKeys: catalog.discoveryTargetKeys, defaultModelTitle: 'Default' });
        // ACP does not prove JSON support for this model. The real consumer
        // keeps discovery reachable without inventing an executable model.
        expect(project(catalog.profiles).selections.size).toBe(0);
        expect(project(catalog.profiles).defaultProfile).toBeNull();
        expect(project([]).groups).toMatchObject([{ discoverable: true }]);
        expect(await read(true)).toMatchObject({ profiles: catalog.profiles });
        const beforeFailure = operationContext.readSnapshot();
        if (!beforeFailure) throw new Error('Requester retired before metadata failure');
        await operationContext.replaceAccountSettings({ ...beforeFailure, settings: accountSettingsParse({
          ...beforeFailure.settings, backendEnabledByTargetKey: { ...beforeFailure.settings.backendEnabledByTargetKey,
            'agent:happier.agent.codex/codex': true },
        }) });
        for (const status of ['unavailable', 'absent'] as const) {
          setPurposeStatus(status);
          const incomplete = await read();
          expect(incomplete).toMatchObject({ profiles: catalog.profiles, automaticProfiles: [],
            unavailableReason: 'account_metadata_unavailable' });
          expect(incomplete).not.toHaveProperty('probeFailures');
        }
        const afterFailure = operationContext.readSnapshot();
        if (!afterFailure) throw new Error('Requester retired during metadata failure');
        await operationContext.replaceAccountSettings({ ...afterFailure, settings: beforeFailure.settings });
        setPurposeStatus('ready');
        const recovered = await read();
        expect(recovered.profiles).toEqual(catalog.profiles);
        expect(recovered).not.toHaveProperty('unavailableReason');
        expect(requests).not.toContain('GET /v2/account/settings');
        expect(requests).not.toContain('GET /v1/account/encryption');
        expect(requests.filter(request => request.startsWith('POST '))).toEqual([]);
        const current = operationContext.readSnapshot();
        if (!current) throw new Error('Requester retired before the disabled-target check');
        await operationContext.replaceAccountSettings({ ...current, settingsVersion: current.settingsVersion + 1, settings: accountSettingsParse({
          ...current.settings, backendEnabledByTargetKey: { ...current.settings.backendEnabledByTargetKey, [targetKey]: false },
        }) });
        const disabled = await read(true);
        expect(disabled.profiles).toEqual([]);
        expect(disabled.discoveryTargetKeys).not.toContain(targetKey);
        expect(requests).toContain(`GET ${ACP_CATALOG_ROWS_ROUTE_V1}`);
        expect(requests.some(request => request.startsWith('POST'))).toBe(false);
        expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
        return;
      }
      const actionId = kind === 'models' ? 'agents.models.list' : 'agents.session_modes.list';
      const id = kind === 'models' ? 'agent-model' : 'agent-mode';
      const label = kind === 'models' ? 'Agent model' : 'Agent mode';
      const context = { surface: 'cli', authority: 'account_automation' } as const;
      const ordinary = await executor.execute(actionId, { backendTargetKey: targetKey }, context);
      expect(ordinary).toMatchObject({ ok: true, result: { source: 'dynamic', items: expect.arrayContaining([
        expect.objectContaining({ id, label, description: process.cwd() }),
      ]) } });
      if (!ordinary.ok) throw new Error(JSON.stringify(ordinary));
      expect(ordinary.result).not.toHaveProperty('probeObservation');

      const explicit = await executor.execute(actionId, { backendTargetKey: targetKey,
        probe: { cwd: directory },
      }, context);
      expect(explicit).toMatchObject({ ok: true, result: { source: 'dynamic', items: expect.arrayContaining([
        expect.objectContaining({ id, label, description: directory }),
      ]), probeObservation: kind === 'models' ? {
        source: 'dynamic', availableModels: expect.arrayContaining([expect.objectContaining({
          id, name: label, description: directory, contextWindowTokens: 32000,
          modelOptions: [expect.objectContaining({ id: 'reasoning', currentValue: 'private-current-value' })],
        })]),
      } : { source: 'dynamic', availableModes: [{ id, name: label, description: directory }] } } });
      expect(requests).toContain(`GET ${ACP_CATALOG_ROWS_ROUTE_V1}`);
      expect(requests.some(request => request.startsWith('POST'))).toBe(false);
      expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
    });
  });

  it('lists row-backed Agents and review engines in requester custody without a Settings write', async () => {
    const { deps, requests, incumbent, operationContext } = await createInventory();
    // Temporary failure-only network diagnostic; the actual Axios adapter and replies stay unchanged.
    const currentnessPath = '/v1/account/encryption/currentness';
    const currentnessOutcomes: Array<Readonly<{ path: string; status?: number; mode?: 'plain' | 'e2ee'; code?: string }>> = [];
    const observer = axios.interceptors.response.use(response => {
      if (response.config.url?.endsWith(currentnessPath)) {
        const data: unknown = response.data;
        const mode = data && typeof data === 'object' && 'mode' in data
          && (data.mode === 'plain' || data.mode === 'e2ee') ? data.mode : undefined;
        currentnessOutcomes.push({ path: currentnessPath, status: response.status, ...(mode ? { mode } : {}) });
      }
      return response;
    }, (error: unknown) => {
      if (axios.isAxiosError(error) && error.config?.url?.endsWith(currentnessPath)) {
        currentnessOutcomes.push({ path: currentnessPath,
          ...(error.response ? { status: error.response.status } : {}),
          ...(error.code ? { code: error.code } : {}),
        });
      }
      return Promise.reject(error);
    });
    try {
      expect(await deps.agentsBackendsList!({ includeDisabled: true })).toMatchObject({ items: expect.arrayContaining([
        expect.objectContaining({ backendId: 'row-review', label: 'Row Review' }),
      ]) });
      expect(await deps.reviewEnginesList!({ sessionId: 'requester-session' })).toMatchObject({ items: expect.arrayContaining([
        expect.objectContaining({ engineId: targetKey, label: 'Row Review' }),
      ]) });
      expect(operationContext.readSnapshot()?.settingsVersion).toBe(7);
      expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
      expect(requests).toContain(`GET ${ACP_CATALOG_ROWS_ROUTE_V1}`);
      expect(requests.some(request => request.startsWith('POST'))).toBe(false);
    } catch (error) {
      console.error('ACP inventory currentness HTTP outcomes:', JSON.stringify(currentnessOutcomes));
      throw error;
    } finally {
      axios.interceptors.response.eject(observer);
    }
  });

  it.each(['partial', 'unavailable'] as const)('discovers built-in inventory with %s ACP authority but refuses configured metadata fallback', async status => {
    const { deps } = await createInventory(status);
    const agents = await deps.agentsBackendsList!({});
    expect(agents.items).toContainEqual(expect.objectContaining({ agentId: 'claude' }));
    expect(agents.items).not.toContainEqual(expect.objectContaining({ backendId: 'row-review' }));
    const reviews = await deps.reviewEnginesList!({ sessionId: 'requester-session' });
    expect(reviews).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ engineId: 'claude' })]) });
    expect(reviews).toMatchObject({ items: expect.not.arrayContaining([expect.objectContaining({ engineId: targetKey })]) });
    await expect(deps.agentsModelsList!({ agentId: 'customAcp', backendTargetKey: targetKey }))
      .rejects.toMatchObject({ code: 'ACP_CATALOG_UNAVAILABLE' });
    await expect(deps.agentsSessionModesList!({ agentId: 'customAcp', backendTargetKey: targetKey }))
      .rejects.toMatchObject({ code: 'ACP_CATALOG_UNAVAILABLE' });
    await expect(deps.agentsConfigOptionsList!({ agentId: 'customAcp', backendTargetKey: targetKey }))
      .rejects.toMatchObject({ code: 'ACP_CATALOG_UNAVAILABLE' });
  });

  it.each(['partial', 'unavailable'] as const)('returns the canonical typed refusal for a %s private detail Action', async status => {
    const { credentials, operationContext, requests, incumbent } = await createInventory(status, { initialRecord: privateDefinitionRecord });
    const observations: unknown[] = [];
    const executor = createActionExecutor({ ...createCliActionDeps({ token: credentials.token, credentials,
      savedSecretOperationContext: operationContext, sessionId: 'requester-session', mode: 'plain', ctx: null }),
      interceptActionExecution: async ({ input }) => ({ status: 'continue', input }),
      observeActionExecution: observation => { observations.push(observation.result); } });
    const result = await executor.execute('agents.acp.backends.get', { backendId: 'row-review' }, { surface: 'cli', authority: 'account_automation' });
    expect(result)
      .toEqual({ ok: false, errorCode: 'acp_catalog_unavailable', error: 'acp_catalog_unavailable' });
    expect(observations).toEqual([{ ok: false, errorCode: 'acp_catalog_unavailable', error: 'acp_catalog_unavailable' }]);
    expect(requests).toContain(`GET ${ACP_CATALOG_ROWS_ROUTE_V1}`);
    expect(requests.some(request => request.startsWith('POST'))).toBe(false);
    expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
  });

  it('does not return a row read after requester custody retires', async () => {
    const { deps } = await createInventory('ready', { retireOnRead: true });
    await expect(deps.agentsBackendsList!({})).rejects.toMatchObject({ code: 'ACP_CATALOG_UNAVAILABLE' });
  });

  it('shares ready ACP authority between builders and retains only built-ins without it', async () => {
    const catalogSnapshot = { status: 'ready', record, revision: 4 } as const;
    expect(await buildAgentBackendInventoryItems({ acpCatalogSnapshot: catalogSnapshot })).toContainEqual(
      expect.objectContaining({ backendId: 'row-review' }));
    expect(await buildReviewEngineInventoryItems({ acpCatalogSnapshot: catalogSnapshot })).toContainEqual(
      expect.objectContaining({ engineId: targetKey }));
    const builtInAgents = await buildAgentBackendInventoryItems({});
    expect(builtInAgents).toContainEqual(expect.objectContaining({ agentId: 'claude' }));
    expect(builtInAgents).not.toContainEqual(expect.objectContaining({ backendId: 'row-review' }));
    const builtInReviews = await buildReviewEngineInventoryItems({});
    expect(builtInReviews).toContainEqual(expect.objectContaining({ engineId: 'claude' }));
    expect(builtInReviews).not.toContainEqual(expect.objectContaining({ engineId: targetKey }));
  });

  it('uses current captured preferences on later row-backed inventory requests', async () => {
    const { deps, operationContext } = await createInventory();
    expect(await deps.agentsBackendsList!({ includeDisabled: true })).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ backendId: 'row-review', enabled: true }),
    ]) });
    const account = operationContext.readSnapshot();
    if (!account) throw new Error('Requester Account retired');
    const rawSettings = { backendEnabledByTargetKey: { [targetKey]: false } };
    expect(await operationContext.replaceAccountSettings({ ...account, settingsVersion: 8,
      rawSettings, settings: accountSettingsParse(rawSettings) })).toBe(true);
    expect(await deps.agentsBackendsList!({ includeDisabled: true })).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ backendId: 'row-review', enabled: false }),
    ]) });
    expect(await deps.agentsBackendsList!({})).toMatchObject({ items: expect.not.arrayContaining([
      expect.objectContaining({ backendId: 'row-review' }),
    ]) });
  });

  it('reads the full private configured definition through the Action and redacts default observations', async () => {
    const { credentials, operationContext, requests, incumbent } = await createInventory('ready', { initialRecord: privateDefinitionRecord });
    const observations: unknown[] = [];
    const executor = createActionExecutor({ ...createCliActionDeps({ token: credentials.token, credentials,
      savedSecretOperationContext: operationContext, sessionId: 'requester-session', mode: 'plain', ctx: null }),
      // The registered plugin hook transport is the boundary; preparation, HTTP read and redaction stay real.
      interceptActionExecution: async ({ input }) => ({ status: 'continue', input }),
      observeActionExecution: observation => { observations.push(observation.result); } });
    for (const surface of ['cli', 'agent', 'mcp'] as const) {
      expect(await executor.execute('agents.acp.backends.get', { backendId: 'row-review' }, {
        surface, authority: 'account_automation',
      })).toEqual({ ok: true, result: { backend: privateDefinitionRecord.definitions[0], revision: 4 } });
    }
    expect(observations).toEqual(Array.from({ length: 3 }, () => ({ ok: true, result: { backendId: 'row-review', revision: 4 } })));
    expect(requests).toContain(`GET ${ACP_CATALOG_ROWS_ROUTE_V1}`);
    expect(requests.some(request => request.startsWith('POST'))).toBe(false);
    expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
  });

  it.each([false, true])('keeps a durable row-CAS receipt truthful when custody retires after acknowledgement: %s', async retireOnWrite => {
    const { credentials, operationContext, requests, writes, incumbent } = await createInventory('ready', { retireOnWrite });
    const deps = createCliActionDeps({ token: credentials.token, credentials, savedSecretOperationContext: operationContext,
      sessionId: 'requester-session', mode: 'plain', ctx: null });
    const result = await runWithServerHttpBaseUrl(operationContext.serverHttpBaseUrl, () => deps.updateAccountAcpCatalogSettings!({ mutate: current => ({
      ...current as { v: 2; backends: AcpCatalogRecordV1['definitions'] },
      backends: [{ ...record.definitions[0], title: 'Edited Review' }],
    }) }));
    expect(requests).toContain(`POST ${ACP_CATALOG_ROWS_ROUTE_V1}`);
    expect(result).toEqual({ ok: true, revision: 5, cleanup: { status: 'cleanup-pending', reason: 'history-incomplete' } });
    expect(writes).toEqual([{ expectedRevision: 4, content: { t: 'plain', v: {
      v: 1, definitions: [{ ...record.definitions[0], title: 'Edited Review' }],
    } }, referencedSavedSecretIds: [], savedSecretRevisions: [] }]);
    expect(requests).not.toContain('POST /v2/account/settings');
    if (retireOnWrite) expect(operationContext.readSnapshot()).toBeNull();
    else expect(operationContext.readSnapshot()?.acpCatalog).toMatchObject({ status: 'ready', revision: 5 });
    expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
  });

  it.each([
    { history: 'complete', retireOnWrite: false },
    { history: 'unavailable', retireOnWrite: false },
    { history: 'complete', retireOnWrite: true },
  ] as const)('projects acknowledged cleanup through both public mutation Actions (%j)', async options => {
    for (const actionId of ['agents.acp.backends.upsert', 'agents.acp.backends.delete'] as const) {
      const { credentials, operationContext, requests, writes, historyWrites, incumbent, readRow, readHistory } = await createInventory('ready', options);
      const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
        savedSecretOperationContext: operationContext, sessionId: 'requester-session', mode: 'plain', ctx: null }));
      const backend = { ...record.definitions[0], title: 'Acknowledged Action edit' };
      const result = await executor.execute(actionId, actionId === 'agents.acp.backends.upsert' ? { backend } : { backendId: backend.id }, {
        surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId },
      });
      expect(writes).toHaveLength(1);
      expect(readRow()).toEqual({ revision: 5, record: { v: 1, definitions: actionId === 'agents.acp.backends.upsert' ? [backend] : [] } });
      const cleanup = options.history === 'complete' && !options.retireOnWrite
        ? { status: 'complete' } : { status: 'cleanup-pending', reason: 'history-incomplete' };
      expect(result).toEqual({ ok: true, result: {
        ...(actionId === 'agents.acp.backends.upsert' ? { backend, revision: 5 } : { backendId: backend.id, deleted: true }), cleanup,
      } });
      if (!options.retireOnWrite) {
        expect(historyWrites).toEqual([expect.objectContaining({ operation: expect.objectContaining({
          transferredPrivateCatalogRevisions: { acp: 5 }, removedRoots: ['acpCatalogSettingsV1'],
        }) })]);
        expect(Object.hasOwn(readHistory(), 'acpCatalogSettingsV1')).toBe(options.history === 'unavailable');
      } else expect(historyWrites).toEqual([]);
      expect(requests).not.toContain('POST /v2/account/settings');
      expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
    }
  });

  it('edits, reads and deletes through confirmed public Actions and the same row CAS', async () => {
    const { credentials, operationContext, writes, requests } = await createInventory();
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      savedSecretOperationContext: operationContext, sessionId: 'requester-session', mode: 'plain', ctx: null }));
    const backend = { ...record.definitions[0], title: 'Action edit' };
    expect(await executor.execute('agents.acp.backends.upsert', { backend }, { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId: 'agents.acp.backends.upsert' } })).toMatchObject({ ok: true, result: { backend, revision: 5 } });
    expect(await executor.execute('agents.acp.backends.get', { backendId: backend.id }, { surface: 'cli', authority: 'present_user' }))
      .toEqual({ ok: true, result: { backend, revision: 5 } });
    expect(await executor.execute('agents.acp.backends.delete', { backendId: backend.id }, { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId: 'agents.acp.backends.delete' } })).toEqual({ ok: true, result: { backendId: backend.id, deleted: true,
        cleanup: { status: 'cleanup-pending', reason: 'history-incomplete' } } });
    expect(await executor.execute('agents.acp.backends.get', { backendId: backend.id }, { surface: 'cli', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'acp_backend_not_found' });
    expect(writes).toMatchObject([{ expectedRevision: 4 }, { expectedRevision: 5, content: { t: 'plain', v: { v: 1, definitions: [] } } }]);
    expect(requests).not.toContain('POST /v2/account/settings');
  });

  it('returns its own acknowledged revision through the public Action when a later writer advances the row during cleanup', async () => {
    const { credentials, operationContext, writes, readRow } = await createInventory('ready', {
      history: 'complete', interleaveOnHistoryRead: true,
    });
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      savedSecretOperationContext: operationContext, sessionId: 'requester-session', mode: 'plain', ctx: null }));
    const backend = { ...record.definitions[0], title: 'Own acknowledged edit' };
    const result = await executor.execute('agents.acp.backends.upsert', { backend, expectedRevision: 4 }, {
      surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'agents.acp.backends.upsert' },
    });
    expect(writes).toHaveLength(1);
    expect(readRow()).toEqual({ revision: 6, record: { v: 1, definitions: [{ ...record.definitions[0], title: 'Later writer' }] } });
    expect(result).toMatchObject({ ok: true, result: { backend, revision: 5 } });
  });

  it('refuses both public stale draft mutations before any POST and preserves the actual row revision', async () => {
    const { credentials, operationContext, writes, requests } = await createInventory('ready', { initialRevision: 1 });
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      savedSecretOperationContext: operationContext, sessionId: 'requester-session', mode: 'plain', ctx: null }));
    for (const actionId of ['agents.acp.backends.upsert', 'agents.acp.backends.delete'] as const) {
      const input = actionId === 'agents.acp.backends.upsert'
        ? { backend: { ...record.definitions[0], title: 'Stale draft' }, expectedRevision: 0 }
        : { backendId: 'row-review', expectedRevision: 0 };
      expect(await executor.execute(actionId, input, { surface: 'cli', authority: 'present_user',
        presentUserConfirmation: { actionId } })).toMatchObject({ ok: false, errorCode: 'acp_catalog_conflict', details: { revision: 1 } });
    }
    expect(writes).toEqual([]);
    expect(requests.some(request => request.startsWith('POST'))).toBe(false);
    expect(await executor.execute('agents.acp.backends.get', { backendId: 'row-review' }, { surface: 'cli', authority: 'present_user' }))
      .toEqual({ ok: true, result: { backend: record.definitions[0], revision: 1 } });
  });

  it('retains only the original-source acknowledgement when custody refuses the authored candidate', async () => {
    const { credentials, operationContext, writes, requests, incumbent, readRow } = await createInventory('ready', {
      initialRowAbsent: true, retireOnWrite: true,
    });
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      savedSecretOperationContext: operationContext, sessionId: 'requester-session', mode: 'plain', ctx: null }));
    const result = await executor.execute('agents.acp.backends.upsert', {
      backend: { ...record.definitions[0], title: 'Unacknowledged authored candidate' },
      expectedRevision: 'absent', sourceSettingsVersion: 7,
    }, { surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'agents.acp.backends.upsert' } });
    expect(writes).toHaveLength(1);
    expect(writes).toEqual([expect.objectContaining({ expectedRevision: 'absent', sourceSettingsVersion: 7,
      content: { t: 'plain', v: expect.objectContaining({ definitions: [expect.objectContaining(record.definitions[0])] }) },
    })]);
    expect(readRow().revision).toBe(0);
    expect(readRow().record.definitions[0]?.title).toBe('Row Review');
    expect(result).toEqual({ ok: false, errorCode: 'ACP_CATALOG_UNAVAILABLE', error: 'ACP_CATALOG_UNAVAILABLE',
      details: { revision: 0, reason: 'scope-retired' } });
    expect(operationContext.readSnapshot()).toBeNull();
    expect(requests).not.toContain('POST /v2/account/settings');
    expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
  });
});

import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema,
  ConnectedAccountCatalogRowMutationResponseV1Schema, sealConnectedAccountCatalogContentV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { randomUUID } from 'node:crypto';

import { AutomationDefinitionDetailsRequestSchema, AutomationDefinitionDetailsResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ActionExecuteResultSchema, ActionOperationAcceptedResultSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1, AutomationActionAdmitRequestV1Schema } from '../../../protocol/src/automations/automationActionOccurrenceV1';
import { FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS, fakeClaudeFixturePath, readFakeClaudeLogEvents } from './fakeClaude';
import type { RecordedHttpProxyRequest } from './httpRequestRecordingProxy';
import { startProjectDaemonFixture } from './daemon/projectDaemon';
import { runCliJson } from './uiE2e/cliJson';
import { readDecryptedSessionMetadataV2 } from './sessionHandoffMetadata';
import { waitFor } from './timing';
import { waitForAssistantMessageContaining } from './providers/scenarios/sessionRuntime';

/** Team setup extends the canonical project journey startup with fake-Agent
 * defaults and scenario observations. Home pairing, auth and daemon lifecycle
 * remain owned by startProjectDaemonFixture and enrollProjectDaemonHome. */
export async function startTeamSetupFFixture(params: Readonly<{
  testDir: string;
  dbProvider?: 'postgres' | 'sqlite';
  guestReachableHome?: Parameters<typeof startProjectDaemonFixture>[0]['guestReachableHome'];
  observeActionRequests?: boolean;
  /** Observe requested/returned saved-health Trigger locators without exposing envelopes. */
  observeSavedHealthSourceSelections?: boolean;
  /** Retain responses for a caller's closed Automation-write failure projection. */
  observeAutomationWriteFailures?: boolean;
  beforeHttpRequest?: (request: RecordedHttpProxyRequest) => void | Promise<void>;
  beforeForwardResponse?: (request: RecordedHttpProxyRequest) => void | Promise<void>;
  captureRequestBody?: (request: RecordedHttpProxyRequest) => boolean;
  requestBodyMaxBytes?: number;
  serverEnv?: Parameters<typeof startProjectDaemonFixture>[0]['serverEnv'];
}>) {
  const core = await startProjectDaemonFixture({ testDir: params.testDir,
    dbProvider: params.dbProvider, guestReachableHome: params.guestReachableHome, serverEnv: params.serverEnv,
    ...((params.observeActionRequests || params.observeSavedHealthSourceSelections || params.observeAutomationWriteFailures || params.beforeHttpRequest || params.beforeForwardResponse || params.captureRequestBody)
      ? { requestObservation: {
        onRequestStart: params.beforeHttpRequest,
        beforeForwardResponse: params.beforeForwardResponse,
        ...(params.requestBodyMaxBytes === undefined ? {} : { requestBodyMaxBytes: params.requestBodyMaxBytes }),
        captureRequestBody: (request: RecordedHttpProxyRequest) => request.path === AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1
          || (params.observeSavedHealthSourceSelections === true && request.path === '/v3/automations/query')
          || params.captureRequestBody?.(request) === true,
        captureResponseBody: params.observeSavedHealthSourceSelections === true || params.observeAutomationWriteFailures === true,
      } } : {}),
  });
  const { server, serverId, sourceOptions, requestProxy } = core;

  // Fresh Accounts have no migrated purpose row. Seed the real encrypted catalog
  // before Session-default admission; an unavailable catalog correctly fails closed.
  async function createAccount(name: string) {
    const account = await core.createAccount(name);
    const headers = { authorization: `Bearer ${account.credentials.token}` };
    const rowUrl = `${server.baseUrl}${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`;
    const existingResponse = await fetch(rowUrl, { headers });
    if (!existingResponse.ok) throw new Error(`Purpose catalog read failed: ${existingResponse.status}`);
    const existing = ConnectedAccountCatalogRowReadResponseV1Schema.parse(await existingResponse.json());
    if (existing.status === 'present') return account;
    if (existing.status !== 'absent') throw new Error(`Purpose catalog seed found ${existing.status}`);
    const settingsResponse = await fetch(`${server.baseUrl}/v2/account/settings`, { headers });
    if (!settingsResponse.ok) throw new Error(`Account settings read failed: ${settingsResponse.status}`);
    const settings: unknown = await settingsResponse.json();
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !('version' in settings)
      || typeof settings.version !== 'number') throw new Error('Account settings seed version missing');
    if (!account.credentials.encryption) throw new Error('Purpose catalog seed requires Account encryption material');
    const content = sealConnectedAccountCatalogContentV1({ mode: 'e2ee', material: account.credentials.encryption,
      record: { key: 'purposes', value: { v: 1, bindings: [] } } });
    const mutationResponse = await fetch(rowUrl, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 'absent', sourceSettingsVersion: settings.version, content }) });
    if (!mutationResponse.ok) throw new Error(`Purpose catalog seed failed: ${mutationResponse.status}`);
    const seeded = ConnectedAccountCatalogRowMutationResponseV1Schema.parse(await mutationResponse.json());
    if (seeded.status !== 'updated') throw new Error(`Purpose catalog seed refused: ${seeded.status}`);
    return account;
  }


  async function enrollDaemon(account: Awaited<ReturnType<typeof createAccount>>,
    options: Parameters<typeof core.enrollDaemon>[1] = {}) {
    return core.enrollDaemon(account, { ...options, env: {
      HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(), ...options.env,
    } });
  }

    async function assertKnownGoodMachineControl(account: Awaited<ReturnType<typeof createAccount>>,
      machine: Readonly<{ target: Readonly<{ serverId: string; machineId: string }> }>) {
      const result = await account.execute('machines.list', { serverId });
      if (!result.ok) throw new Error(`F baseline Machine read refused (${result.errorCode})`);
      const listed = result.result;
      const items = listed && typeof listed === 'object' && 'items' in listed ? listed.items : null;
      if (!Array.isArray(items) || !items.some(item => item && typeof item === 'object'
        && 'serverId' in item && item.serverId === machine.target.serverId
        && 'machineId' in item && item.machineId === machine.target.machineId)) {
        throw new Error('F baseline enrolled Machine is not visible to its Account');
      }
    }

    async function assertSessionAgentOutput(account: Awaited<ReturnType<typeof createAccount>>, sessionId: string,
      requiredSubstring = 'FAKE_CLAUDE_OK_') {
      const sessionCrypto = await readDecryptedSessionMetadataV2({ baseUrl: server.baseUrl,
        token: account.auth.token, sessionId, machineKeys: [account.auth.accountMachineKey] });
      if (!sessionCrypto.selectedSecret) throw new Error('F Session content key unavailable');
      await waitForAssistantMessageContaining({ baseUrl: server.baseUrl, token: account.auth.token,
        sessionId, secret: sessionCrypto.selectedSecret,
        encryptionVariant: sessionCrypto.selectedUsesDataKeyVariant ? 'dataKey' : 'legacy',
        requiredSubstring, timeoutMs: FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS });
    }

    return { ...core,
      createAccount, enrollDaemon, assertKnownGoodMachineControl, assertSessionAgentOutput,
      /** The real vendor process reaches its native MCP host; the test supplies no caller authority. */
      async executeSessionMcpAction(account: Awaited<ReturnType<typeof createAccount>>,
        session: Readonly<{ sessionId: string; logPath: string }>, actionId: ActionId, input: unknown) {
        const requestId = randomUUID();
        const sent = await account.execute('session.message.send', { sessionId: session.sessionId,
          message: `SESSION_MCP_ACTION_JSON:${JSON.stringify({ requestId, actionId, input })}`, reply: 'none' });
        if (!sent.ok) throw createActionExecuteFailureError(sent);
        const admission = SessionMessageSendResultV1Schema.parse(sent.result);
        if (admission.status !== 'accepted' && admission.status !== 'alreadyAccepted') {
          throw new Error(`Native MCP Agent turn was not admitted (${JSON.stringify(admission)})`);
        }
        let outcome: unknown;
        await waitFor(async () => {
          const event = (await readFakeClaudeLogEvents(session.logPath)).find(row =>
            row.type === 'session_mcp_action_result' && row.requestId === requestId);
          outcome = event?.result;
          return event !== undefined;
        }, { timeoutMs: FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS, context: 'Native Session MCP Action result' });
        const executed = ActionExecuteResultSchema.parse(outcome);
        if (!executed.ok) return executed;
        const receipt = ActionOperationAcceptedResultSchema.safeParse(executed.result);
        if (!receipt.success) return executed;
        // Native finite Actions return admission; their existing exact operation read owns completion.
        const observed = await account.execute('action.operations.get', { serverId,
          machineId: receipt.data.machineId, operationId: receipt.data.operationId, waitForTerminal: true });
        if (!observed.ok) throw createActionExecuteFailureError(observed);
        const found = ActionOperationGetV1ResponseSchema.parse(observed.result);
        if (found.kind !== 'found') throw new Error('Native MCP Action operation was not found');
        const operation = found.operation;
        if (operation.state === 'failed' && operation.error) {
          return ActionExecuteResultSchema.parse({ ok: false, ...operation.error });
        }
        if (operation.state === 'cancelled') return { ok: false as const, errorCode: 'cancelled', error: 'cancelled' };
        if (operation.state !== 'succeeded') throw new Error(`Native MCP Action operation did not settle (${operation.state})`);
        return { ...executed, result: operation.result };
      },
      async assertKnownGoodSessionControl(account: Awaited<ReturnType<typeof createAccount>>,
        machine: Parameters<typeof core.assertKnownGoodSessionControl>[1],
        agent?: Readonly<{ target: NonNullable<Parameters<typeof core.assertKnownGoodSessionControl>[2]>;
          prompt: string; assistantSubstring: string }>) {
        const control = await core.assertKnownGoodSessionControl(account, machine, agent?.target);
        const sent = await account.execute('session.message.send', {
          sessionId: control.sessionId, message: agent?.prompt ?? 'Confirm the Team setup F control reaches its enrolled Agent.', reply: 'none',
        });
        if (!sent.ok) throw new Error(`F baseline Agent turn refused (${sent.errorCode})`);
        const admission = SessionMessageSendResultV1Schema.parse(sent.result);
        if (admission.status !== 'accepted' && admission.status !== 'alreadyAccepted') {
          throw new Error(`F baseline Agent turn was not admitted (${JSON.stringify(admission)})`);
        }
        await assertSessionAgentOutput(account, control.sessionId, agent?.assistantSubstring);
        return control;
      },
      createSessionFromArgv(machine: Awaited<ReturnType<typeof enrollDaemon>>, args: string[], label: string) {
        return runCliJson({ testDir: params.testDir, cliHomeDir: machine.homeDir,
          serverUrl: server.baseUrl, webappUrl: server.baseUrl, label,
          env: { ...process.env, NODE_OPTIONS: sourceOptions,
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' },
          launchOptions: { preferSourceEntrypoint: true, skipSharedDepsBuild: true },
          args: ['session', 'create', '--path', machine.workspaceDir, '--terminal-json', '{"mode":"plain"}', '--json', ...args],
        });
      },
      takeRequestObservations() {
        if (!requestProxy) throw new Error('F fixture Action request observation was not enabled');
        // Credentials remain at the transport boundary; this projection has no headers.
        const observations = requestProxy.entries().map(request => {
          const { method, path, statusCode } = request;
          if (!params.observeSavedHealthSourceSelections || path !== '/v3/automations/query' || !request.body?.complete || request.body.truncated) return { method, path, statusCode };
          const query = AutomationDefinitionDetailsRequestSchema.safeParse(JSON.parse(request.body.text));
          if (!query.success || !('healthCheckSources' in query.data)) return { method, path, statusCode };
          const selection = query.data.healthCheckSources;
          if (!selection || typeof selection !== 'object') return { method, path, statusCode };
          if (!request.responseBody?.complete || request.responseBody.truncated) throw new Error('Incomplete selected-source HTTP observation');
          const page = AutomationDefinitionDetailsResponseSchema.parse(JSON.parse(request.responseBody.text));
          // Only opaque source locators leave the recorder; no config, envelope or credential bytes.
          return { method, path, statusCode, definitionSourceSelection: {
            sources: 'sources' in selection ? selection.sources : undefined,
            returnedTriggerIds: page.automations.flatMap(row => row.triggers.map(trigger => trigger.id)),
          } };
        });
        requestProxy.clear();
        return observations;
      },
      readActionOccurrences() {
        if (!requestProxy) throw new Error('F fixture Action request observation was not enabled');
        return requestProxy.entries().filter(request => request.path === AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1)
          .map(request => AutomationActionAdmitRequestV1Schema.parse(JSON.parse(request.body?.text ?? 'null')));
      },
    };
}

export type TeamSetupFFixture = Awaited<ReturnType<typeof startTeamSetupFFixture>>;

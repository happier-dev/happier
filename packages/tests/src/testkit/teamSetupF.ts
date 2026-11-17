import { AutomationDefinitionDetailsRequestSchema, AutomationDefinitionDetailsResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1, AutomationActionAdmitRequestV1Schema } from '../../../protocol/src/automations/automationActionOccurrenceV1';
import { fakeClaudeFixturePath } from './fakeClaude';
import type { RecordedHttpProxyRequest } from './httpRequestRecordingProxy';
import { startProjectDaemonFixture } from './daemon/projectDaemon';
import { runCliJson } from './uiE2e/cliJson';

/** Team setup extends the canonical project journey startup with fake-Agent
 * defaults and scenario observations. Home pairing, auth and daemon lifecycle
 * remain owned by startProjectDaemonFixture and enrollProjectDaemonHome. */
export async function startTeamSetupFFixture(params: Readonly<{
  testDir: string;
  dbProvider?: 'postgres' | 'sqlite';
  observeActionRequests?: boolean;
  /** Observe requested/returned saved-health Trigger locators without exposing envelopes. */
  observeSavedHealthSourceSelections?: boolean;
  beforeHttpRequest?: (request: RecordedHttpProxyRequest) => void | Promise<void>;
  captureRequestBody?: (request: RecordedHttpProxyRequest) => boolean;
  requestBodyMaxBytes?: number;
  serverEnv?: Parameters<typeof startProjectDaemonFixture>[0]['serverEnv'];
}>) {
  const core = await startProjectDaemonFixture({ testDir: params.testDir,
    dbProvider: params.dbProvider, serverEnv: params.serverEnv,
    ...((params.observeActionRequests || params.observeSavedHealthSourceSelections || params.beforeHttpRequest || params.captureRequestBody)
      ? { requestObservation: {
        onRequestStart: params.beforeHttpRequest,
        ...(params.requestBodyMaxBytes === undefined ? {} : { requestBodyMaxBytes: params.requestBodyMaxBytes }),
        captureRequestBody: (request: RecordedHttpProxyRequest) => request.path === AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1
          || (params.observeSavedHealthSourceSelections === true && request.path === '/v3/automations/query')
          || params.captureRequestBody?.(request) === true,
        captureResponseBody: params.observeSavedHealthSourceSelections === true,
      } } : {}),
  });
  const { server, serverId, sourceOptions, requestProxy, createAccount } = core;

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

    return { ...core,
      createAccount, enrollDaemon, assertKnownGoodMachineControl,
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

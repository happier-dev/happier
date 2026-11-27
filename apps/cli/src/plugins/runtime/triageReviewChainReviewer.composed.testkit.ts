import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  ActionExecuteAfterHookPayloadSchema,
  type ActionExecuteAfterHookPayload,
} from '@happier-dev/plugin-sdk/hooks';
import { REVIEW_START_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import {
  createFiniteExecutionRunHostRuntime,
  type AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createDeterministicSessionAgentRuntime } from '../../../../../packages/plugin-sdk/examples/session-agent/agent/deterministicSessionAgent';
import { createDaemonControlApp } from '@/daemon/controlServer';
import {
  createDaemonAdmissionDrain,
  EXECUTION_RUN_ADMISSION_PATH,
} from '@/daemon/lifecycle/admissionDrain';
import { isValidConnectedServiceRunMaterializeToken } from '@/daemon/connectedServices/runs/capabilityToken';
import { writeDaemonStateFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import type { V2SessionRecord } from '@happier-dev/protocol';
import {
  StoredSessionSharedMetadataV1Schema,
  projectSessionOwnerCompatibilityViewV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { TranscriptOpenedAgentStateV1Schema } from '@happier-dev/protocol/actions/actionSpecs';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createAccountSessionClientTransport } from '@/api/client/createAccountSessionClientTransport';
import { createSessionSocketTransport } from '@/api/session/connection/createSessionSocketTransport';
import { createUserScopedSocket } from '@/api/session/sockets';
import { SESSION_CLIENT_ACCOUNT_CHANGE_KINDS } from '@/api/session/sessionChangesSyncOnConnect';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import {
  tryDecryptSessionMetadata,
  tryOpenSessionOwnerMetadata,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { tryReadApiSessionMetadataForLayout } from '@/session/metadata/sessionMetadataLayout';
import type { StoredCredentials } from '@/persistence';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';

/** Open the actual persisted birth tuple through the ordinary Session owners.
 * Socket endpoints are redirected to the already-running Home
 * boundary; native creation has already established its Machine AccessKey.
 */
export function createChainParentSessionClient(
  options: Readonly<{
    row: V2SessionRecord;
    credentials: StoredCredentials;
    machineId: string;
    socketOrigin: string;
    actionsSettingsProvider: RuntimeActionSettingsProvider;
  }>,
) {
  const { row, credentials } = options;
  if (row.encryptionMode !== 'plain' || row.metadataLayoutVersion !== 1)
    throw new Error('The chain requires its actual plain layout-one birth');
  const shared = StoredSessionSharedMetadataV1Schema.parse(
    tryDecryptSessionMetadata({ credentials, rawSession: row }),
  );
  const owner = tryOpenSessionOwnerMetadata({
    credentials,
    accountEncryptionMode: 'plain',
    rawSession: row,
  });
  const runtimeMetadata = tryReadApiSessionMetadataForLayout(
    shared,
    row.metadataLayoutVersion,
  );
  if (!owner || !runtimeMetadata)
    throw new Error('The born Session tuple could not be opened');
  const transport = createAccountSessionClientTransport(credentials.token);
  return createTestApiSessionClient(
    ApiSessionClient,
    credentials.token,
    {
      id: row.id,
      seq: row.seq,
      encryptionMode: 'plain',
      metadata: {
        ...runtimeMetadata,
        ...projectSessionOwnerCompatibilityViewV1({
          sharedMetadata: shared,
          ownerMetadata: owner.ownerMetadata,
        }),
      },
      metadataLayoutVersion: row.metadataLayoutVersion,
      ...owner,
      metadataVersion: row.metadataVersion,
      agentState: row.agentState
        ? TranscriptOpenedAgentStateV1Schema.parse(JSON.parse(row.agentState))
        : null,
      agentStateVersion: row.agentStateVersion ?? 0,
    },
    {
      localMachineId: options.machineId,
      actionsSettingsProvider: options.actionsSettingsProvider,
      metadataAuthority: {
        kind: 'owner',
        credentials,
        readCurrentCredentials: async () => credentials,
      },
      transport: {
        ...transport,
        createAccountUpdatesSocket: (sessionId) =>
          createUserScopedSocket({
            token: credentials.token,
            serverUrl: options.socketOrigin,
            accountChangeRows: SESSION_CLIENT_ACCOUNT_CHANGE_KINDS,
            sessionUpdateInterest: sessionId,
          }),
        createSessionSocketTransport: (binding) =>
          createSessionSocketTransport({
            token: credentials.token,
            ...binding,
            serverUrl: options.socketOrigin,
            accessKeyBinding: 'preestablished',
          }),
      },
    },
  );
}

export const CHAIN_REVIEWER_IDENTITY = {
  pluginId: 'test.triage-chain-reviewer',
  localId: 'reviewer',
} as const;
export const CHAIN_SESSION_AGENT_IDENTITY = {
  pluginId: CHAIN_REVIEWER_IDENTITY.pluginId,
  localId: 'session-agent',
} as const;

// This is the external reviewer/model answer. The host Review profile still
// prepares the real captured comparison and parses this answer normally.
const answer = JSON.stringify({
  summary: 'The captured comparison was reviewed.',
  findings: [],
});
const createReviewerRuntime: AgentRuntimeFactory = () => ({
  executionRuns: {
    async open(request, context) {
      return createFiniteExecutionRunHostRuntime({
        request,
        signal: context.signal,
        async execute({ emit }) {
          emit({ kind: 'output-delta', channel: 'assistant', text: answer });
          return { status: 'complete' };
        },
        mapFailure: () => ({
          code: 'fixture_reviewer_failed',
          message: 'Fixture reviewer failed',
        }),
        unsupportedSendDiagnostic: {
          code: 'fixture_finite_review',
          message: 'The review is finite',
        },
      });
    },
  },
});

const defineReviewerPlugin = (
  observeReviewAction?: (payload: ActionExecuteAfterHookPayload) => void,
) =>
  definePlugin({
    id: CHAIN_REVIEWER_IDENTITY.pluginId,
    version: '0.0.0',
    displayName: 'Triage chain reviewer',
    entrypoints: { daemon: './daemon.mjs' },
    hooks: {
      'observe-review-result': {
        declaration: { on: 'action.execute.after' },
        handler: async (payload) => {
          const parsed = ActionExecuteAfterHookPayloadSchema.parse(payload);
          if (parsed.actionId === REVIEW_START_ACTION_ID_V1)
            observeReviewAction?.(parsed);
        },
      },
    },
    agents: {
      'session-agent': {
        declaration: {
          title: 'Triage chain Session Agent',
          runtime: { kind: 'custom' },
          primary: 'sessions',
          capabilities: {
            sessions: {
              open: ['create', 'resume'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        },
        factory: createDeterministicSessionAgentRuntime,
        sessionRunnerFactory: {
          module: './session-runner.mjs',
          export: 'createDeterministicSessionAgentRuntime',
          runtimeApiVersion: 1,
        },
      },
      reviewer: {
        declaration: {
          title: 'Triage chain reviewer',
          runtime: { kind: 'custom' },
          primary: 'executionRuns',
          capabilities: {
            executionRuns: {
              open: ['create'],
              checkpoint: false,
              stop: true,
              workspaceWrites: 'deny',
            },
          },
        },
        factory: createReviewerRuntime,
      },
    },
    executionRunProfiles: {
      review: {
        id: 'review',
        intent: 'review',
        title: 'Finite review',
        compatibleAgents: ['reviewer'],
        promptAsset: 'review-prompt',
        defaults: {
          retention: 'ephemeral',
          runClass: 'bounded',
          io: 'requestResponse',
        },
      },
    },
    resources: {
      'review-prompt-resource': {
        kind: 'prompt',
        path: './resources/review.md',
        contentType: 'text/markdown',
      },
    },
    promptAssets: {
      'review-prompt': {
        kind: 'systemPrompt',
        resource: 'review-prompt-resource',
        target: { kind: 'agent', agent: 'reviewer' },
      },
    },
  });

/** Append this to the same createAuthoredAdmittedPluginRuntimeFixture.plugins
 * array as Triage/GitHub/Channels. No registry/inventory/Run method is replaced.
 * The authored plugin registers its real public-SDK runtime through activation.
 */
export function createChainReviewerPluginRecipe(
  options?: Readonly<{
    observeReviewAction?: (payload: ActionExecuteAfterHookPayload) => void;
  }>,
) {
  const plugin = defineReviewerPlugin(options?.observeReviewAction);
  return {
    manifest: plugin.manifest,
    files: {
      'resources/review.md':
        'Review the admitted captured comparison. Return JSON with summary and findings.',
      'daemon.mjs': 'export function activate() {}',
      // Reuse the maintained SDK Agent, including its exact executable
      // leaf. The journey substitutes only the physical Session launch.
      'session-runner.mjs': stripTypeScriptTypes(
        readFileSync(
          new URL(
            '../../../../../packages/plugin-sdk/examples/session-agent/agent/deterministicSessionAgent.ts',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    },
    instantiateCommittedModule: () => ({ activate: plugin.activate }),
  };
}

/** Real scoped-token HTTP admission. Only the explicitly supplied temporary
 * Home receives a fixture state file; no ambient Home path is written.
 *
 * Configure the parent test's configuration.daemonStateFile to statePath (or
 * use withConfiguredDaemonTestHome) so the real daemonPost discovers it. Merely
 * replacing configuration.happyHomeDir does not redirect that separate field.
 * The parent temporary-Home teardown owns removal of the fixture state file.
 */
export async function startChainReviewDaemonAdmission(
  options: Readonly<{
    happyHomeDir: string;
    serverId: string;
    machineId: string;
    getChildren?: Parameters<typeof createDaemonControlApp>[0]['getChildren'];
  }>,
) {
  const controlToken = randomUUID();
  const admissionDrain = createDaemonAdmissionDrain();
  const admissionRequests: Array<Readonly<{ status: number }>> = [];
  const app = createDaemonControlApp({
    machineId: options.machineId,
    getChildren: options.getChildren ?? (() => []),
    admissionDrain,
    controlToken,
    verifyRunMaterializeToken: (provided) =>
      isValidConnectedServiceRunMaterializeToken(provided, controlToken),
    // The composed journey owns Session spawning separately. These unused
    // OS/lifecycle ports fail visibly if the journey accidentally takes one.
    spawnSession: async () => {
      throw new Error('Unexpected spawn through the Review admission daemon');
    },
    stopSession: async () => {
      throw new Error('Unexpected stop through the Review admission daemon');
    },
    requestShutdown: () => {
      throw new Error(
        'Unexpected shutdown through the Review admission daemon',
      );
    },
    onHappySessionWebhook: () => {
      throw new Error(
        'Unexpected Session webhook through the Review admission daemon',
      );
    },
  });
  app.addHook('onResponse', async (request, reply) => {
    if (request.url === EXECUTION_RUN_ADMISSION_PATH)
      admissionRequests.push({ status: reply.statusCode });
  });
  const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
  const target = {
    pid: process.pid,
    httpPort: Number(address.port),
    controlToken,
  };
  const statePath = await writeDaemonStateFixture(
    options.happyHomeDir,
    options.serverId,
    target,
  );
  return {
    statePath,
    admissionRequests,
    close: () => app.close(),
  };
}

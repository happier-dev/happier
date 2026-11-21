import fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  accountSettingsParse,
  FeaturesResponseSchema,
} from '@happier-dev/protocol';
import {
  normalizeActionsSettingsV1,
  type ActionsSettingsV1,
} from '@happier-dev/protocol/actions/actionSettings';
import {
  buildSessionApprovalConsentsHeaderV1,
  SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
} from '@happier-dev/protocol/actions/sessionApprovalConsentsV1';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { createRetainedAccountExecutionRuntime } from '@/plugins/runtime/accountExecutionRuntime';
// Collect the real lazy runtime before the test clock; source transformation is not Action work.
import '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import '@/daemon/connectedServices/purposeBindings/createRequesterConnectedAccountPurposeBindingRuntime';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { StoredCredentials } from '@/persistence';
import { createHappierMcpServer } from './createHappierMcpServer';

type Outcome = 'asked' | 'ran' | `other:${string}`;

/**
 * A plugin-contributed Account Action that the Session runner executes in its own process
 * (plugin registry lease, no daemon authority path). Only Home HTTP storage is replaced; the
 * MCP server, plugin executor, contributed-Action owner and the consent reader stay real.
 */
async function withRunnerPluginHost(
  accountActions: ActionsSettingsV1,
  run: (
    host: Readonly<{
      actionId: string;
      seedRows: (boundSessionId: string, mode: 'allowed' | 'ask_first') => void;
      call: (sessionId: string) => Promise<Outcome>;
    }>,
  ) => Promise<void>,
) {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'session-consent-plugin-'));
  const app = fastify();
  const accountId = 'session-consent-plugin-owner';
  const serverId = 'session-consent-plugin-home';
  const serverUrl = 'http://session-consent-plugin.test';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const credentials: StoredCredentials = {
    token,
    credentialProvenance: 'stored_session',
    encryption: null,
  };
  registerAccountHomeHttp(app, {
    accountId,
    serverId,
    settings: { actionsSettingsV1: accountActions },
  });
  const authored = await registerAuthoredAccountActionRelease(app, accountId);
  const actionId = formatQualifiedPluginActionId({
    pluginId: authored.pluginId,
    localId: 'echo',
  });
  let onApprovalCreated: (() => void) | null = null;
  app.addHook('onResponse', async (request) => {
    if (request.method === 'POST' && request.url === '/v1/artifacts')
      onApprovalCreated?.();
  });
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
  const lifetime = new AbortController();
  const retained = createRetainedAccountExecutionRuntime(() => ({
    happyHomeDir,
    accountExecution: {
      credentials,
      serverUrl,
      serverId,
      isCurrent: () => !lifetime.signal.aborted,
    },
  }));
  try {
    await runWithServerHttpBaseUrl(serverUrl, () =>
      authored.publishArtifacts(credentials),
    );
    const accountRuntime = await runWithServerHttpBaseUrl(serverUrl, () =>
      retained.read(),
    );
    let seeded = 0;
    await run({
      actionId,
      seedRows: (boundSessionId, mode) => {
        authored.artifacts.seed(
          `consents-${++seeded}`,
          encodePlainArtifactStoredContent(
            buildSessionApprovalConsentsHeaderV1(boundSessionId),
          ),
          encodePlainArtifactStoredContent({
            body: JSON.stringify({
              v: 1,
              kind: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
              sessionId: boundSessionId,
              rows: [{ actionId, audience: 'agent', mode }],
            }),
          }),
        );
      },
      call: async (sessionId) => {
        const turn = new AbortController();
        const client = Object.assign(
          createMutableApiSessionClientFixture({
            sessionId,
            metadata: createTestMetadata(),
            overrides: {
              getServerBinding: () => ({ serverId, serverUrl }),
              getServerFeaturesSnapshot: () => ({
                status: 'ready',
                provenance: 'authenticated',
                features: FeaturesResponseSchema.parse({
                  features: {},
                  capabilities: {},
                }),
              }),
            },
          }),
          {
            getActiveTurnAdmissionWitness: () => ({
              turnId: `${sessionId}-turn`,
              inputId: `${sessionId}-input`,
              userMessageSeq: 1,
              userMessageSeqs: [1],
              signal: turn.signal,
              agentStartCaller: {
                kind: 'session' as const,
                sessionId,
                starterDepth: 0,
                turnDepth: 0,
              },
            }),
          },
        );
        const runtime = createHappierMcpServer(client, {
          credentials,
          accountSettings: accountSettingsParse({
            actionsSettingsV1: accountActions,
          }),
          toolExecutionSignal: turn.signal,
          pluginRuntimeRegistryLease: {
            registry: accountRuntime.registry,
            source: 'ephemeral',
            durableRevision: -1,
            release: async () => {},
            accountRuntime: retained,
          },
        });
        const asked = new Promise<Outcome>((resolve) => {
          onApprovalCreated = () => resolve('asked');
        });
        const pending = runWithServerHttpBaseUrl(serverUrl, () =>
          runtime.executeTool({
            toolName: 'action_execute',
            args: { actionId, input: { key: sessionId } },
          }),
        );
        try {
          return await Promise.race([
            asked,
            pending.then((result): Outcome =>
              result.ok && JSON.stringify(result.result).includes(sessionId)
                ? 'ran'
                : `other:${JSON.stringify(result)}`,
            ),
          ]);
        } finally {
          onApprovalCreated = null;
          turn.abort();
          await pending.catch(() => {});
          await runtime.mcp.close();
        }
      },
    });
  } finally {
    lifetime.abort();
    await retained.dispose();
    restore();
    await app.close();
    resetActiveAccountSettingsSnapshotForTests();
    await rm(happyHomeDir, { recursive: true, force: true });
  }
}

it('applies the calling Session\'s "Ask first" to an in-process plugin Action the Account allows', async () => {
  await withRunnerPluginHost(
    normalizeActionsSettingsV1({ v: 1 }),
    async (host) => {
      // The Account rule alone runs this safe Action.
      expect(await host.call('consent-plugin-no-row')).toBe('ran');
      host.seedRows('consent-plugin-ask', 'ask_first');
      expect(await host.call('consent-plugin-ask')).toBe('asked');
    },
  );
});

it('applies the calling Session\'s "Allowed" over the Account "Ask first", and only for that Session', async () => {
  const accountAskFirst = (actionId: string) =>
    normalizeActionsSettingsV1({
      v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } },
    });
  await withRunnerPluginHost(
    accountAskFirst('acme.account-actions/actions/echo'),
    async (host) => {
      expect(host.actionId).toBe('acme.account-actions/actions/echo');
      // No row: the Account rule asks.
      expect(await host.call('consent-plugin-account')).toBe('asked');
      host.seedRows('consent-plugin-allowed', 'allowed');
      expect(await host.call('consent-plugin-allowed')).toBe('ran');
      // Another Session's row never answers this Session's call.
      host.seedRows('consent-plugin-elsewhere', 'allowed');
      expect(await host.call('consent-plugin-caller')).toBe('asked');
    },
  );
});

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import axios from 'axios';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { SessionMetadataOwnerPatchV1Schema, StoredSessionOwnerMetadataEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import {
  buildLinkedExternalSessionQualifiedIdentityV1,
  createSessionOwnerMetadataV1,
  ExternalSessionsSourceSchema,
  type PluginAgentExternalSessionLinkDataObject,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createExternalSessionSourceKeyOwnerFromAgentProjection, resolveExternalSessionSourceFromAgentProjection } from '@/plugins/projection/registry/externalSessionSources';
import { resolveBackendEngineAdapterResolution } from '@/agent/runtime/registry/engineRegistry';
import { createAccountEncryptionCurrentnessFixture, createSessionListResponseFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildExternalSessionMetadata, ensureExternalSessionLink } from './ensureExternalSessionLink';

/**
 * Every first-party Agent that contributes External Sessions.
 *
 * This guard drives the REAL registered contribution — never a hand-built
 * `linkData` literal, which is exactly what let a plugin consumer break while
 * its own fixture stayed green — and asserts the persisted envelope the link
 * flow would actually write: every host identity and custody fact stays
 * host-owned, and the Agent's payload reaches persistence only on its own
 * `externalSessionV1.linkData` carrier.
 *
 * The fixture list is bound to registered link-capable sources below. Agents
 * declaring only resume discovery cannot produce persisted linked identities.
 */
const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'HAPPIER_CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'GROK_HOME',
  'KIMI_CODE_HOME',
] as const;

const sourceInventoryReads = vi.hoisted(() => [] as string[]);
// Filesystem enumeration is the boundary: keep source admission, the registered
// contribution, link metadata and transport logic real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, opendir: (...args: Parameters<typeof actual.opendir>) => {
    sourceInventoryReads.push(String(args[0]));
    return actual.opendir(...args);
  } };
});

type LinkIdentityProbe = Readonly<{
  source: Record<string, unknown>;
  remoteSessionId: string;
  linkData?: PluginAgentExternalSessionLinkDataObject;
}>;

type FirstPartyAgentLinkFixture = Readonly<{
  agentId: string;
  pluginId: string;
  /**
   * Prepares the Agent's real on-disk (or pure) source and returns the probe the
   * production link flow would perform. `listCandidates` is used wherever the
   * Agent can enumerate offline so the candidate's own `linkData` is real too.
   */
  prepare(params: Readonly<{
    root: string;
    env: ReturnType<typeof createEnvKeyScope>;
    listCandidates: (source: Record<string, unknown>) => Promise<readonly Readonly<{
      remoteSessionId: string;
      linkData?: PluginAgentExternalSessionLinkDataObject;
    }>[]>;
  }>): Promise<LinkIdentityProbe>;
}>;

type OpenCodeAttachStub = Readonly<{ baseUrl: string; close: () => Promise<void> }>;

let openCodeAttachStub: OpenCodeAttachStub | null = null;

/**
 * OpenCode reaches every External Sessions source through a managed service: a
 * `baseUrl` source becomes an attach spec the host supervises and health-checks
 * on `/global/health` before any leaf operation runs, so there is no offline
 * `resolveLinkIdentity` for this Agent. The probe therefore attaches to a real
 * loopback server answering exactly that health route; a dead address would
 * spend the whole invocation deadline in the managed-endpoint bind.
 */
async function startOpenCodeAttachStub(): Promise<OpenCodeAttachStub> {
  const server = createServer((request, response) => {
    if (request.url === '/global/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ok"}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('OpenCode attach stub did not bind a loopback port');
  }
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function firstCandidateProbe(params: Readonly<{
  source: Record<string, unknown>;
  listCandidates: (source: Record<string, unknown>) => Promise<readonly Readonly<{
    remoteSessionId: string;
    linkData?: PluginAgentExternalSessionLinkDataObject;
  }>[]>;
}>): Promise<LinkIdentityProbe> {
  const candidates = await params.listCandidates(params.source);
  const candidate = candidates[0];
  if (!candidate) throw new Error('expected one enumerable external-session candidate');
  return {
    source: params.source,
    remoteSessionId: candidate.remoteSessionId,
    ...(candidate.linkData ? { linkData: candidate.linkData } : {}),
  };
}

const FIRST_PARTY_AGENT_LINK_FIXTURES: readonly FirstPartyAgentLinkFixture[] = [
  {
    agentId: 'claude',
    pluginId: 'happier.agent.claude',
    async prepare({ root, env, listCandidates }) {
      const configDir = join(root, 'claude');
      const projectDir = join(configDir, 'projects', 'proj-guard');
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'claude-guard-session.jsonl'),
        jsonl({
          type: 'user',
          uuid: 'claude-guard-user',
          sessionId: 'claude-guard-session',
          timestamp: '2026-07-23T10:00:00.000Z',
          cwd: '/repo',
          message: { role: 'user', content: 'guard prompt' },
        }),
        'utf8',
      );
      env.patch({ CLAUDE_CONFIG_DIR: configDir, HAPPIER_CLAUDE_CONFIG_DIR: configDir });
      return await firstCandidateProbe({ source: { kind: 'claudeConfig' }, listCandidates });
    },
  },
  {
    agentId: 'codex',
    pluginId: 'happier.agent.codex',
    async prepare({ root, env, listCandidates }) {
      const codexHome = join(root, 'codex');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });
      const remoteSessionId = '11111111-1111-1111-1111-111111111111';
      await writeFile(
        join(sessionsDir, `rollout-2026-07-23T10-00-00-${remoteSessionId}.jsonl`),
        [
          jsonl({
            type: 'session_meta',
            timestamp: '2026-07-23T10:00:00.000Z',
            payload: {
              id: remoteSessionId,
              timestamp: '2026-07-23T10:00:00.000Z',
              cwd: '/repo',
            },
          }),
          jsonl({
            type: 'response_item',
            timestamp: '2026-07-23T10:01:00.000Z',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'guard prompt' }],
            },
          }),
        ].join(''),
        'utf8',
      );
      env.patch({ CODEX_HOME: codexHome });
      return await firstCandidateProbe({
        source: { kind: 'codexHome', home: 'user' },
        listCandidates,
      });
    },
  },
  {
    agentId: 'opencode',
    pluginId: 'happier.agent.opencode',
    /**
     * OpenCode enumerates through its running server, so the offline probe binds
     * the same pure identity resolver the link flow calls after enumeration.
     */
    async prepare() {
      openCodeAttachStub = await startOpenCodeAttachStub();
      return {
        source: {
          kind: 'opencodeServer',
          baseUrl: openCodeAttachStub.baseUrl,
          directory: '/repo',
        },
        remoteSessionId: 'ses_guard_opencode',
      };
    },
  },
  {
    agentId: 'ohMyPi',
    pluginId: 'happier.agent.ohmypi',
    async prepare({ root, env, listCandidates }) {
      const agentDir = join(root, 'ohmypi');
      const sessionRoot = join(agentDir, 'sessions', '-repo');
      await mkdir(sessionRoot, { recursive: true });
      const remoteSessionId = '153e1829e9d3e497';
      await writeFile(
        join(sessionRoot, `2026-07-23T10-00-00-000Z_${remoteSessionId}.jsonl`),
        [
          jsonl({
            type: 'session',
            version: 3,
            id: remoteSessionId,
            timestamp: '2026-07-23T10:00:00.000Z',
            cwd: '/repo',
          }),
          jsonl({
            type: 'message',
            id: 'omp-guard-user',
            parentId: null,
            timestamp: '2026-07-23T10:00:01.000Z',
            message: { role: 'user', content: [{ type: 'text', text: 'guard prompt' }] },
          }),
        ].join(''),
        'utf8',
      );
      env.patch({ PI_CODING_AGENT_DIR: agentDir });
      return await firstCandidateProbe({ source: { kind: 'ohMyPiAgentDir' }, listCandidates });
    },
  },
  {
    agentId: 'pi',
    pluginId: 'happier.agent.pi',
    async prepare({ root, env, listCandidates }) {
      const agentDir = join(root, 'pi');
      const sessionRoot = join(agentDir, 'sessions', '--repo--');
      await mkdir(sessionRoot, { recursive: true });
      const remoteSessionId = 'pi-guard-session';
      await writeFile(
        join(sessionRoot, `2026-07-23T10-00-00-000Z_${remoteSessionId}.jsonl`),
        [
          jsonl({
            type: 'session',
            version: 3,
            id: remoteSessionId,
            timestamp: '2026-07-23T10:00:00.000Z',
            cwd: '/repo',
          }),
          jsonl({
            type: 'message',
            id: 'pi-guard-user',
            parentId: null,
            timestamp: '2026-07-23T10:00:01.000Z',
            message: { role: 'user', content: 'guard prompt' },
          }),
        ].join(''),
        'utf8',
      );
      env.patch({ PI_CODING_AGENT_DIR: agentDir });
      return await firstCandidateProbe({ source: { kind: 'piAgentDir' }, listCandidates });
    },
  },
  {
    agentId: 'antigravity',
    pluginId: 'happier.agent.antigravity',
    async prepare({ root, env, listCandidates }) {
      const home = join(root, 'antigravity-home');
      const conversationId = 'antigravity-guard-conversation';
      const logsDir = join(
        home,
        '.gemini',
        'antigravity-cli',
        'brain',
        conversationId,
        '.system_generated',
        'logs',
      );
      await mkdir(logsDir, { recursive: true });
      await writeFile(
        join(logsDir, 'transcript_full.jsonl'),
        jsonl({ id: 'antigravity-guard-entry', type: 'USER_INPUT', text: 'guard prompt' }),
        'utf8',
      );
      env.patch({ HOME: home, USERPROFILE: home });
      return await firstCandidateProbe({
        source: { kind: 'antigravityCliPrint' },
        listCandidates,
      });
    },
  },
  // Reuse the readers' provenance-backed fixtures. Each contribution has its
  // own source admission/identity producer even when its linkData is empty;
  // the host-envelope check must exercise that registered producer as well.
  {
    agentId: 'auggie', pluginId: 'happier.agent.auggie',
    async prepare({ root, listCandidates }) {
      const { buildAuggieNativeSession } = await import('../../../../../../../packages/plugins/auggie/src/agent/surfaces/sessions/external/__fixtures__/nativeSession.test-support');
      const directory = join(root, 'sessions');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'native-session.json'), JSON.stringify(buildAuggieNativeSession(['guard prompt'])));
      return firstCandidateProbe({ source: { kind: 'auggieHome', augmentHome: root }, listCandidates });
    },
  },
  {
    agentId: 'codebuddy', pluginId: 'happier.agent.codebuddy',
    async prepare({ root, listCandidates }) {
      const directory = join(root, 'projects', 'fixture-workspace');
      await mkdir(directory, { recursive: true });
      await copyFile(new URL('../../../../../../../packages/plugins/codebuddy/src/agent/externalSessions/__fixtures__/codebuddy-2.170.0-producer.jsonl', import.meta.url), join(directory, 'fixture-session.jsonl'));
      return firstCandidateProbe({ source: { kind: 'codebuddyHome', homeDir: root }, listCandidates });
    },
  },
  {
    agentId: 'copilot', pluginId: 'happier.agent.copilot',
    async prepare({ root, listCandidates }) {
      const directory = join(root, 'session-state', 'native');
      await mkdir(directory, { recursive: true });
      await copyFile(new URL('../../../../../../../packages/plugins/copilot/src/agent/externalSessions/__fixtures__/copilot-v1-events.jsonl', import.meta.url), join(directory, 'events.jsonl'));
      return firstCandidateProbe({ source: { kind: 'copilotHome', homeDir: root }, listCandidates });
    },
  },
  {
    agentId: 'cursor', pluginId: 'happier.agent.cursor',
    async prepare({ root, listCandidates }) {
      const { writeCursorNativeFixture } = await import('../../../../../../../packages/plugins/cursor/src/agent/externalSessions/__fixtures__/native.test-support');
      await writeCursorNativeFixture(root);
      return firstCandidateProbe({ source: { kind: 'cursorHome', homeDir: root }, listCandidates });
    },
  },
  {
    agentId: 'devin', pluginId: 'happier.agent.devin',
    async prepare({ root, listCandidates }) {
      const { createDevinNativeFixture } = await import('../../../../../../../packages/plugins/devin/src/agent/externalSessions/__fixtures__/nativeSession.test-support');
      const native = createDevinNativeFixture(root, ['guard prompt']);
      try {
        return await firstCandidateProbe({ source: { kind: 'devinHome', devinHome: root }, listCandidates });
      } finally { native.close(); }
    },
  },
  {
    agentId: 'droid', pluginId: 'happier.agent.droid',
    async prepare({ root, env, listCandidates }) {
      const factoryDir = join(root, '.factory');
      const directory = join(factoryDir, 'sessions', '-workspace');
      await mkdir(directory, { recursive: true });
      await copyFile(new URL('../../../../../../../packages/plugins/droid/src/agent/externalSessions/__fixtures__/droid-0.170.0-transcript-v2.jsonl', import.meta.url), join(directory, 'session-fixture.jsonl'));
      env.patch({ HOME: root, USERPROFILE: root });
      return firstCandidateProbe({ source: { kind: 'droidFactoryDir', factoryDir }, listCandidates });
    },
  },
  {
    agentId: 'fx', pluginId: 'happier.agent.fx',
    async prepare({ root, env, listCandidates }) {
      const directory = join(root, '.fx', 'sessions', 'native-session');
      await mkdir(directory, { recursive: true });
      await copyFile(new URL('../../../../../../../packages/plugins/fx/src/agent/externalSessions/__fixtures__/fx-v0.0.14-events.jsonl', import.meta.url), join(directory, 'events.jsonl'));
      // The same schema-v4 metadata envelope as the FX reader's owner fixture.
      await writeFile(join(directory, 'session.json'), JSON.stringify({ schema_version: 4,
        id: 'native-session', origin_workspace_root: '/repo', workspace_root: '/repo',
        created_at_ms: 1792490400000, updated_at_ms: 1792490400010,
        conversation_language: 'en', provider: 'openai', model: 'fixture-model', effort: 'medium',
        fast_mode: false, title: 'ordinary title', subagent_child: false }));
      env.patch({ HOME: root, USERPROFILE: root });
      return firstCandidateProbe({ source: { kind: 'fxHome' }, listCandidates });
    },
  },
  {
    agentId: 'gemini', pluginId: 'happier.agent.gemini',
    async prepare({ root, listCandidates }) {
      const fixture = await import('../../../../../../../packages/plugins/gemini/src/agent/surfaces/sessions/external/__fixtures__/gemini064');
      const directory = join(root, 'tmp', 'project', 'chats');
      await mkdir(directory, { recursive: true });
      await writeFile(join(root, 'projects.json'), JSON.stringify({ projects: { '/repo': 'project' } }));
      await writeFile(join(directory, 'session-2026-10-20T10-00-8b6e1959.jsonl'), fixture.jsonl());
      return firstCandidateProbe({ source: { kind: 'geminiConfigDir', configDir: root }, listCandidates });
    },
  },
  {
    agentId: 'grok', pluginId: 'happier.agent.grok',
    async prepare({ root, env, listCandidates }) {
      const { createGrokNativeHistoryFixture } = await import('../../../../../../../packages/plugins/grok/src/agent/externalSessions/__fixtures__/grokNative.test-support');
      await createGrokNativeHistoryFixture(root);
      env.patch({ GROK_HOME: join(root, '.grok') });
      return firstCandidateProbe({ source: { kind: 'grokHome' }, listCandidates });
    },
  },
  {
    agentId: 'kilo', pluginId: 'happier.agent.kilo',
    async prepare({ root, listCandidates }) {
      // Identity reads the existing session document; message/part decoding is
      // covered by Kilo's own transcript contract and is not duplicated here.
      const captured: unknown = JSON.parse(await readFile(new URL('../../../../../../../packages/plugins/kilo/src/agent/externalSessions/__fixtures__/kilo-json-1.0.25.json', import.meta.url), 'utf8'));
      if (!captured || typeof captured !== 'object' || !('session' in captured)) throw new Error('Missing Kilo session fixture');
      const directory = join(root, 'session', 'project');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'ses_fixture.json'), JSON.stringify(captured.session));
      return firstCandidateProbe({ source: { kind: 'kiloStorage', storageRoot: root }, listCandidates });
    },
  },
  {
    agentId: 'kimi', pluginId: 'happier.agent.kimi',
    async prepare({ root, env, listCandidates }) {
      const { writeKimiFixture } = await import('../../../../../../../packages/plugins/kimi/src/agent/externalSessions/__fixtures__/kimiCode.test-support');
      await writeKimiFixture(root);
      env.patch({ KIMI_CODE_HOME: root });
      return firstCandidateProbe({ source: { kind: 'kimiCodeHome' }, listCandidates });
    },
  },
  {
    agentId: 'kiro', pluginId: 'happier.agent.kiro',
    async prepare({ root, listCandidates }) {
      const { createKiroChatV1Fixture } = await import('../../../../../../../packages/plugins/kiro/src/agent/externalSessions/__fixtures__/kiroChatV1.test-support');
      await createKiroChatV1Fixture({ home: root });
      return firstCandidateProbe({ source: { kind: 'kiroChatStore', kiroHome: root }, listCandidates });
    },
  },
  {
    agentId: 'qwen', pluginId: 'happier.agent.qwen',
    async prepare({ root, listCandidates }) {
      const fixture = await import('../../../../../../../packages/plugins/qwen/src/agent/externalSessions/__fixtures__/qwen0253');
      const directory = join(root, 'projects', '-repo', 'chats');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${fixture.sessionId}.jsonl`), fixture.jsonl());
      return firstCandidateProbe({ source: { kind: 'qwenRuntimeDir', runtimeDir: root }, listCandidates });
    },
  },
];

describe('first-party Agent link identities and host owner metadata', () => {
  it.each(['complete', 'cancel', 'accepted-project', 'project-refresh', 'creation-unconfirmed', 'project-unsupported', 'project-invalid', 'project-forbidden', 'project-mode-mismatch', 'project-retired'] as const)('keeps native link creation under the admitted operation lifetime (%s)', async outcomeKind => {
    await withTempDir('happier-native-link-lifetime-', async root => {
      const env = createEnvKeyScope(ENV_KEYS);
      const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
      let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
      let creationResponse: ServerResponse | undefined;
      let creationTimeout: number | undefined;
      let releaseCreation: (() => void) | undefined;
      let completed: Promise<void> | undefined;
      let createdMetadata = '{}';
      let createdOwnerMetadata: ReturnType<typeof StoredSessionOwnerMetadataEnvelopeV1Schema.parse> | undefined;
      const metadataPatches: ReturnType<typeof SessionMetadataOwnerPatchV1Schema.parse>[] = [];
      const projectReads: unknown[] = [];
      let publisherCurrent = true;
      let linkCreated = false;
      let metadataVersion = 0;
      const sessionRecord = () => createSessionRecordFixture({ id: 'native-linked-session',
        encryptionMode: 'plain', currentStorageState: 'machine_only', metadataLayoutVersion: 1,
        metadata: createdMetadata, metadataVersion, ownerMetadata: createdOwnerMetadata, share: null });
      const inventoryReads = { active: 0, archived: 0 };
      const interceptor = axios.interceptors.request.use(config => {
        if (config.url?.endsWith('/v1/sessions')) {
          creationTimeout = config.timeout;
          const data: unknown = config.data;
          if (data && typeof data === 'object') {
            const metadata: unknown = Reflect.get(data, 'sharedMetadata');
            if (metadata && typeof metadata === 'object') {
              const ciphertext: unknown = Reflect.get(metadata, 'ciphertext');
              if (typeof ciphertext === 'string') createdMetadata = ciphertext;
            }
            createdOwnerMetadata = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(Reflect.get(data, 'ownerMetadata'));
          }
        }
        if (config.method === 'patch') {
          const patch = SessionMetadataOwnerPatchV1Schema.parse(config.data);
          metadataPatches.push(patch);
          createdMetadata = patch.sharedMetadata.ciphertext;
          createdOwnerMetadata = patch.ownerMetadata;
          metadataVersion += 1;
        }
        if (config.url?.endsWith(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`)) projectReads.push(config.data);
        return config;
      });
      const server = createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        request.resume();
        if (request.url === '/v1/account/encryption/currentness') {
          response.end(JSON.stringify(createAccountEncryptionCurrentnessFixture()));
        } else if (request.url === '/v1/account/encryption') {
          response.end(JSON.stringify({ mode: 'plain', updatedAt: 0 }));
        } else if (request.url === '/v1/features' || request.url === '/v1/features/authenticated') {
          response.end(JSON.stringify(FeaturesResponseSchema.parse({ features: {}, capabilities: { encryption: {
            storagePolicy: 'optional', defaultAccountMode: 'plain', allowAccountOptOut: true,
          }, serverIdentity: { serverIdentityId: 'srv_native_link_home' } } })));
        } else if (request.url === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
          if (outcomeKind === 'project-invalid') {
            response.end(JSON.stringify({ status: 'listed', coverage: 'complete', rows: 'unreadable-census' }));
            return;
          }
          if (outcomeKind === 'project-unsupported' || outcomeKind === 'project-forbidden') {
            response.statusCode = outcomeKind === 'project-unsupported' ? 404 : 403;
            response.end('{}');
            return;
          }
          const key = { kind: 'workspace-ref', serverId: 'srv_native_link_home', id: 'accepted-native-checkout' };
          if (outcomeKind === 'project-retired') publisherCurrent = false;
          response.end(JSON.stringify({ status: 'listed', coverage: 'complete', rows: [{ key, revision: 0,
            content: outcomeKind === 'project-mode-mismatch' ? { t: 'encrypted', c: 'unavailable-private-content' } : { t: 'plain', v: { key, value: { id: key.id, serverId: key.serverId,
              machineId: 'fixture-machine', rootPath: root, projectKey: 'accepted-native-project', createdAtMs: 1 } } } }] }));
        } else if (request.url?.includes('/sessions/native-linked-session')) {
          if (request.method === 'PATCH') {
            response.end(JSON.stringify({ success: true, metadataLayoutVersion: 1, sharedMetadata: { version: metadataVersion }, agentState: { version: 1 } }));
          } else {
            response.end(JSON.stringify({ session: sessionRecord() }));
          }
        } else if (request.url === '/v2/sessions/lookup-by-tags') {
          response.end(JSON.stringify({ sessions: outcomeKind === 'project-refresh' && linkCreated ? [sessionRecord()] : [] }));
        } else if (request.url && ['/v2/sessions', '/v2/sessions/archived'].includes(new URL(request.url, 'http://fixture').pathname)) {
          inventoryReads[new URL(request.url, 'http://fixture').pathname.endsWith('/archived') ? 'archived' : 'active'] += 1;
          response.end(JSON.stringify(createSessionListResponseFixture([])));
        } else if (request.url === '/v1/sessions') {
          if (outcomeKind === 'project-refresh' && linkCreated) {
            response.end(JSON.stringify({ created: false, session: sessionRecord() }));
            return;
          }
          creationResponse = response;
          releaseCreation = () => { if (!response.writableEnded) { linkCreated = true; response.end(JSON.stringify({
            ...(outcomeKind === 'creation-unconfirmed' ? {} : { created: true }), session: createSessionRecordFixture({
            id: 'native-linked-session', encryptionMode: 'plain', currentStorageState: 'machine_only', metadataLayoutVersion: 1,
            metadata: createdMetadata, ownerMetadata: createdOwnerMetadata, share: null,
          }) })); } };
        } else {
          response.statusCode = 404;
          response.end('{}');
        }
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing native-link HTTP fixture');
      try {
        runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: join(root, 'happy-home'),
          runtimeOptions: { contributes, pluginIds: ['happier.agent.claude'] } });
        const resolution = await resolveBackendEngineAdapterResolution('claude', { runtimeRegistry: runtime.registry });
        const surface = resolution?.executionSurfaces.externalSession;
        if (!surface?.listCandidates || !surface.resolveLinkIdentity) throw new Error('Missing registered Claude source');
        const fixture = FIRST_PARTY_AGENT_LINK_FIXTURES[0];
        const probe = await fixture.prepare({ root, env, listCandidates: async source => {
          const listed = await surface.listCandidates!({ source: ExternalSessionsSourceSchema.parse(source), limit: 5 });
          return listed.candidates;
        } });
        sourceInventoryReads.length = 0;
        const admitted = await surface.validateSource!({ source: ExternalSessionsSourceSchema.parse(probe.source) });
        expect(admitted.ok).toBe(true);
        // Opening one known conversation must not enumerate accounting history
        // before reaching the indexed-link or transcript reader.
        expect(sourceInventoryReads).toEqual([]);
        const controller = new AbortController();
        let outcome: unknown;
        completed = runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => ensureExternalSessionLink({
          credentials: { token: 'synthetic-link-account', encryption: null }, machineId: 'fixture-machine', agentId: 'claude',
          source: ExternalSessionsSourceSchema.parse(probe.source), remoteSessionId: probe.remoteSessionId, linkData: probe.linkData, signal: controller.signal,
          shouldCommit: () => publisherCurrent,
          ...(outcomeKind !== 'complete' && outcomeKind !== 'cancel' && outcomeKind !== 'project-refresh' ? { directoryHint: root } : {}),
        }, {
          resolveExternalSessionProviderOps: async () => surface,
          resolveCurrentAgent: async () => ({ identity: { pluginId: fixture.pluginId, localId: fixture.agentId }, sourceKinds: ['claudeConfig'] }),
          resolveSourceKeyOwner: async (agentId, source) => createExternalSessionSourceKeyOwnerFromAgentProjection(contributes, agentId, source),
        })).then(value => { outcome = value; }, error => { outcome = error; });
        await vi.waitFor(() => expect(creationResponse, String(outcome)).toBeDefined());
        // Axios is the real HTTP boundary: the containing operation owns cancellation,
        // so this phase must not activate its standalone 60-second deadline.
        expect(creationTimeout).toBe(0);
        // Legacy-tag recovery must not refetch the same Account inventory for
        // every released tag before opening a new native conversation.
        expect(inventoryReads).toEqual({ active: 1, archived: 1 });
        if (outcomeKind === 'cancel') {
          controller.abort();
          await vi.waitFor(() => expect(outcome).toMatchObject({ code: 'outcome_unknown', cause: { code: 'ERR_CANCELED' } }));
        } else {
          releaseCreation?.();
          await completed;
          if (outcomeKind === 'project-forbidden') {
            expect(outcome).toMatchObject({ response: { status: 403 } });
          } else if (outcomeKind === 'project-mode-mismatch') {
            expect(outcome).toMatchObject({ code: 'project_account_mode_mismatch' });
          } else if (outcomeKind === 'project-retired') {
            expect(outcome).toMatchObject({ code: 'cancelled' });
          } else {
            expect(outcome).toMatchObject({ sessionId: 'native-linked-session', created: true });
          }
          if (outcomeKind === 'accepted-project') {
            expect(metadataPatches).toMatchObject([{ projectKey: 'accepted-native-project', ownerMetadata: { t: 'plain',
              v: { workspace: { workspaceId: 'accepted-native-checkout', projectId: 'accepted-native-project' } } } }]);
            expect(projectReads).toEqual([{ kinds: ['workspace-ref'], serverId: 'srv_native_link_home' }]);
          } else {
            expect(metadataPatches).toEqual([]);
            if (outcomeKind === 'creation-unconfirmed') expect(projectReads).toEqual([]);
          }
          if (outcomeKind === 'project-refresh') {
            expect(projectReads).toEqual([]);
            await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => ensureExternalSessionLink({
              credentials: { token: 'synthetic-link-account', encryption: null }, machineId: 'fixture-machine', agentId: 'claude',
              source: ExternalSessionsSourceSchema.parse(probe.source), remoteSessionId: probe.remoteSessionId,
              linkData: probe.linkData, directoryHint: root, signal: controller.signal, shouldCommit: () => publisherCurrent,
            }, {
              resolveExternalSessionProviderOps: async () => surface,
              resolveCurrentAgent: async () => ({ identity: { pluginId: fixture.pluginId, localId: fixture.agentId }, sourceKinds: ['claudeConfig'] }),
              resolveSourceKeyOwner: async (agentId, source) => createExternalSessionSourceKeyOwnerFromAgentProjection(contributes, agentId, source),
            }));
            expect(metadataPatches).toMatchObject([{ projectKey: 'accepted-native-project', ownerMetadata: { t: 'plain',
              v: { workspace: { workspaceId: 'accepted-native-checkout', projectId: 'accepted-native-project' } } } }]);
            expect(metadataPatches).toHaveLength(1);
          }
        }
      } finally {
        releaseCreation?.();
        await completed;
        axios.interceptors.request.eject(interceptor);
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await runtime?.dispose();
        env.restore();
      }
    });
  });

  it('covers every Agent declaring a link-capable External Sessions source', () => {
    const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
    const linkCapableAgentIds = contributes.agents
      .filter((agent) => agent.richDefinition?.definition.surfaces?.externalSession
        ?.sources.some((source) => source.resumeOnly !== true))
      .map((agent) => agent.id);
    expect([...FIRST_PARTY_AGENT_LINK_FIXTURES.map((fixture) => fixture.agentId)].sort())
      .toEqual(linkCapableAgentIds.sort());
  });

  it('keeps every registered Agent link identity out of the host-owned persisted envelope', async () => {
    await withTempDir('happier-first-party-link-owner-metadata-', async (root) => {
      const envScope = createEnvKeyScope([...ENV_KEYS]);
      let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
      const rejectedByAgentId: Record<string, readonly string[]> = {};
      const persistedByAgentId: Record<string, Record<string, unknown>> = {};
      const resolvedSourceAdmissionByAgentId: Record<string, string> = {};
      const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
      try {
        runtimeFixture = await createAdmittedPluginRuntimeFixture({
          happyHomeDir: join(root, 'happy-home'),
          runtimeOptions: {
            contributes,
            pluginIds: FIRST_PARTY_AGENT_LINK_FIXTURES.map((fixture) => fixture.pluginId),
          },
        });

        for (const fixture of FIRST_PARTY_AGENT_LINK_FIXTURES) {
          const resolution = await resolveBackendEngineAdapterResolution(fixture.agentId, {
            runtimeRegistry: runtimeFixture.registry,
          });
          const externalSession = resolution?.executionSurfaces.externalSession;
          if (!externalSession?.resolveLinkIdentity) {
            throw new Error(`missing External Sessions surface for ${fixture.agentId}`);
          }

          const agentRoot = join(root, fixture.agentId);
          await mkdir(agentRoot, { recursive: true });
          const probe = await fixture.prepare({
            root: agentRoot,
            env: envScope,
            listCandidates: async (source) => {
              const listed = await externalSession.listCandidates!({
                source: ExternalSessionsSourceSchema.parse(source),
                limit: 5,
              });
              return listed.candidates;
            },
          });

          const linked = await externalSession.resolveLinkIdentity({
            source: ExternalSessionsSourceSchema.parse(probe.source),
            remoteSessionId: probe.remoteSessionId,
            ...(probe.linkData ? { metadata: { linkData: probe.linkData } } : {}),
          });

          // Every source an Agent resolves must be readmissible under the Agent's
          // OWN declared source schema: the host revalidates it on every later
          // link, transcript, observation and takeover operation, so a resolved
          // carrier field the declaration never admits silently kills the link.
          const readmitted = resolveExternalSessionSourceFromAgentProjection(
            { agents: contributes.agents },
            fixture.agentId,
            linked.source,
          );
          resolvedSourceAdmissionByAgentId[fixture.agentId] = readmitted.ok
            ? 'ok'
            : readmitted.code;

          // The persisted envelope the link flow would write for this Agent.
          const persisted = buildExternalSessionMetadata({
            tag: `${fixture.agentId}-guard`,
            machineId: 'guard-machine',
            agentId: fixture.agentId,
            remoteSessionId: probe.remoteSessionId,
            source: linked.source,
            qualifiedIdentity: buildLinkedExternalSessionQualifiedIdentityV1({
              agent: { pluginId: fixture.pluginId, localId: fixture.agentId.toLowerCase() },
              sourceKind: linked.source.kind,
            }),
            runtimeDescriptor: linked.runtimeDescriptor ?? null,
            ...(linked.vendorMetadata ? { vendorMetadata: linked.vendorMetadata } : {}),
            ...(linked.externalSessionMetadata
              ? { externalSessionMetadata: linked.externalSessionMetadata }
              : {}),
            directoryHint: '/repo',
            nowMs: 1_700_000_000_000,
          });
          persistedByAgentId[fixture.agentId] = persisted;
          const ownerMetadata = createSessionOwnerMetadataV1({ metadata: persisted });
          rejectedByAgentId[fixture.agentId] = ownerMetadata.ok
            ? []
            : ownerMetadata.unsupportedFields;
        }
      } finally {
        await runtimeFixture?.dispose();
        await openCodeAttachStub?.close();
        openCodeAttachStub = null;
        envScope.restore();
      }

      expect(rejectedByAgentId).toEqual(Object.fromEntries(
        FIRST_PARTY_AGENT_LINK_FIXTURES.map((fixture) => [fixture.agentId, []]),
      ));

      expect(resolvedSourceAdmissionByAgentId).toEqual(Object.fromEntries(
        FIRST_PARTY_AGENT_LINK_FIXTURES.map((fixture) => [fixture.agentId, 'ok']),
      ));

      for (const fixture of FIRST_PARTY_AGENT_LINK_FIXTURES) {
        const persisted = persistedByAgentId[fixture.agentId]!;
        const externalSessionV1 = persisted.externalSessionV1 as Record<string, unknown>;
        expect({ agentId: fixture.agentId, persisted: {
          tag: persisted.tag,
          path: persisted.path,
          machineId: persisted.machineId,
          flavor: persisted.flavor,
          linkAgentId: externalSessionV1.agentId,
          linkMachineId: externalSessionV1.machineId,
          linkedAtMs: externalSessionV1.linkedAtMs,
        } }).toEqual({ agentId: fixture.agentId, persisted: {
          tag: `${fixture.agentId}-guard`,
          path: '/repo',
          machineId: 'guard-machine',
          flavor: fixture.agentId,
          linkAgentId: fixture.agentId,
          linkMachineId: 'guard-machine',
          linkedAtMs: 1_700_000_000_000,
        } });
      }
    });
  }, 120_000);
});

import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

import {
  buildLinkedExternalSessionQualifiedIdentityV1,
  createSessionOwnerMetadataV1,
  EXTERNAL_SESSIONS_AGENT_IDS,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveExternalSessionSourceFromAgentProjection } from '@/plugins/projection/registry/externalSessionSources';
import { resolveBackendEngineAdapterResolution } from '@/agent/runtime/registry/engineRegistry';
import { buildExternalSessionMetadata } from './ensureExternalSessionLink';

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
 * The fixture list is bound to the generated External Sessions census below, so
 * a newly registered Agent cannot silently escape the guard.
 */
const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'HAPPIER_CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
] as const;

type LinkIdentityProbe = Readonly<{
  source: Record<string, unknown>;
  remoteSessionId: string;
  linkData?: Record<string, unknown>;
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
      linkData?: Record<string, unknown>;
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
    linkData?: Record<string, unknown>;
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
];

describe('first-party Agent link identities and host owner metadata', () => {
  it('covers every Agent in the registered External Sessions census', () => {
    expect([...FIRST_PARTY_AGENT_LINK_FIXTURES.map((fixture) => fixture.agentId)].sort())
      .toEqual([...EXTERNAL_SESSIONS_AGENT_IDS].sort());
  });

  it('keeps every registered Agent link identity out of the host-owned persisted envelope', async () => {
    await withTempDir('happier-first-party-link-owner-metadata-', async (root) => {
      const envScope = createEnvKeyScope([...ENV_KEYS]);
      let runtimeRegistry: Awaited<
        ReturnType<typeof resolveExecutablePluginRuntimeRegistry>
      > | null = null;
      const rejectedByAgentId: Record<string, readonly string[]> = {};
      const persistedByAgentId: Record<string, Record<string, unknown>> = {};
      const resolvedSourceAdmissionByAgentId: Record<string, string> = {};
      const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
      try {
        runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
          contributes,
          happyHomeDir: join(root, 'happy-home'),
          pluginIds: FIRST_PARTY_AGENT_LINK_FIXTURES.map((fixture) => fixture.pluginId),
        });

        for (const fixture of FIRST_PARTY_AGENT_LINK_FIXTURES) {
          const resolution = await resolveBackendEngineAdapterResolution(fixture.agentId, {
            runtimeRegistry,
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
                source: source as never,
                limit: 5,
              });
              return listed.candidates as never;
            },
          });

          const linked = await externalSession.resolveLinkIdentity({
            source: probe.source as never,
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
        await runtimeRegistry?.dispose();
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

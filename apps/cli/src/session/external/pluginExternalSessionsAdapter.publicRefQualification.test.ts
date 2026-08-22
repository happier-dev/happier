import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/sessions/external';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
  activate as activateOhMyPiPlugin,
  PLUGIN_MANIFEST as OH_MY_PI_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-ohmypi';
import {
  activate as activatePiPlugin,
  PLUGIN_MANIFEST as PI_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-pi';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  executeExternalSessionCandidateQuery,
  hydrateExternalSessionCandidateThroughAgentSource,
} from '@/session/actions/externalSessions/candidateQuery';
import {
  createBoundedAgentExternalSessionsContribution,
} from '@/session/external/agentExternalSessionsInvocation';
import {
  createAgentExternalSessionsExecutionSurface,
} from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import {
  createPluginExternalSessionsAdapter,
  type PluginExternalSessionsProviderOps,
} from './pluginExternalSessionsAdapter';

const roots = new Set<string>();
const unavailableInvocationExec = createUnavailablePluginServices().exec;

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function registeredExternalSessionsContribution(params: Readonly<{
  agentId: 'pi' | 'ohmypi';
}>): Promise<AgentExternalSessionsContribution> {
  const activation = await createPluginTestkit(
    params.agentId === 'pi'
      ? { manifest: PI_PLUGIN_MANIFEST, module: { activate: activatePiPlugin } }
      : { manifest: OH_MY_PI_PLUGIN_MANIFEST, module: { activate: activateOhMyPiPlugin } },
  );
  const contribution = activation.registration('agents', params.agentId)?.externalSessions;
  await activation.dispose();
  if (!contribution) {
    throw new Error(`Expected ${params.agentId} External Sessions contribution`);
  }
  return contribution;
}

function providerOpsFromRealLeaf(params: Readonly<{
  agentId: 'pi' | 'ohmypi';
  pluginId: string;
  contribution: AgentExternalSessionsContribution;
}>): PluginExternalSessionsProviderOps {
  const retirement = new AbortController();
  const surface = createAgentExternalSessionsExecutionSurface(
    createBoundedAgentExternalSessionsContribution({
      contribution: params.contribution,
      identity: {
        pluginId: params.pluginId,
        agentId: params.agentId,
        generation: 'test-generation',
        contributionQualifiedId: `${params.pluginId}/agents/${params.agentId}`,
        immutableGenerationId: null,
      },
      isCurrent: () => true,
      retirementSignal: retirement.signal,
      createInvocationExec: async () => unavailableInvocationExec,
    }),
  );
  if (
    !surface.validateSource
    || !surface.listCandidates
    || !surface.pageTranscript
    || !surface.resolveLinkIdentity
  ) {
    throw new Error('Expected complete real-leaf External Sessions surface');
  }
  const listCandidates = vi.fn(surface.listCandidates);
  return Object.freeze({
    validateSource: surface.validateSource,
    listCandidates,
    pageTranscript: surface.pageTranscript,
    resolveLinkIdentity: surface.resolveLinkIdentity,
    ...(surface.readAfterTranscript
      ? { readAfterTranscript: surface.readAfterTranscript }
      : {}),
  });
}

function createRealLeafAdapter(params: Readonly<{
  agentId: 'pi' | 'ohmypi';
  pluginId: string;
  sourceId: string;
  source: { kind: 'piAgentDir' | 'ohMyPiAgentDir' };
  contribution: AgentExternalSessionsContribution;
  activeServerDir: string;
}>) {
  const ops = providerOpsFromRealLeaf(params);
  return {
    adapter: createPluginExternalSessionsAdapter({
    isCurrent: () => true,
    sources: [{
      agentId: params.agentId,
      sourceId: params.sourceId,
      source: params.source,
    }],
    resolveProviderOps: async () => ops,
    queryCandidates: async ({ entry, ops: candidateOps, source, cursor, limit, maxBytes, signal }) => (
      await executeExternalSessionCandidateQuery({
        activeServerDir: params.activeServerDir,
        agentIdentity: { pluginId: params.pluginId, localId: entry.agentId },
        source,
        ...(cursor ? { cursor } : {}),
        limit,
        maxBytes,
        listCandidates: async (request) => await candidateOps.listCandidates({
          source,
          ...request,
          maxBytes,
          signal,
        }),
        hydrateCandidate: async (candidate) => (
          await hydrateExternalSessionCandidateThroughAgentSource({
            source,
            candidate,
            providerOps: candidateOps,
            maxBytes,
            signal,
          })
        ),
      })
    ),
    }),
    listCandidates: ops.listCandidates,
  };
}

async function listUntilPublished(
  realLeafAdapter: ReturnType<typeof createRealLeafAdapter>,
) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const page = await realLeafAdapter.adapter.authorService.list({ limit: 10 });
    if (page.items.length > 0) return page;
  }
  throw new Error('Real-leaf candidate index did not publish within its bounded scan');
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([...roots].map(async (root) => await rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe('public ExternalSessionRef qualification', () => {
  it('reads a real Pi candidate using only its three-field public listed ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-public-ref-pi-'));
    roots.add(root);
    const activeServerDir = join(root, 'server');
    const agentDir = join(root, '.pi', 'agent');
    const sessionRoot = join(agentDir, 'sessions', '--workspace--');
    const remoteSessionId = 'pi-public-ref';
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(join(sessionRoot, `2026-08-10T10-00-00.000Z_${remoteSessionId}.jsonl`), [
      jsonl({ type: 'session', version: 3, id: remoteSessionId, timestamp: '2026-08-10T10:00:00.000Z', cwd: '/workspace' }),
      jsonl({ type: 'message', id: 'pi-public-ref-user', parentId: null, timestamp: '2026-08-10T10:00:01.000Z', message: { role: 'user', content: 'Pi public-ref transcript' } }),
    ].join(''), 'utf8');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

    const realLeafAdapter = createRealLeafAdapter({
      agentId: 'pi',
      pluginId: 'happier.agent.pi',
      sourceId: 'piAgentDir:test',
      source: { kind: 'piAgentDir' },
      contribution: await registeredExternalSessionsContribution({ agentId: 'pi' }),
      activeServerDir,
    });
    const listed = await listUntilPublished(realLeafAdapter);
    const ref = listed.items[0]?.ref;
    expect(ref).toEqual({
      agentId: 'pi',
      sourceId: 'piAgentDir:test',
      remoteSessionId,
    });
    expect(Object.keys(ref ?? {}).sort()).toEqual([
      'agentId',
      'remoteSessionId',
      'sourceId',
    ]);

    const listCandidates = vi.mocked(realLeafAdapter.listCandidates);
    const listCallsAfterListing = listCandidates.mock.calls.length;
    await expect(realLeafAdapter.adapter.authorService.readTranscript(ref!)).resolves.toMatchObject({
      mode: 'page',
      items: [expect.objectContaining({ kind: 'user' })],
    });
    expect(listCandidates).toHaveBeenCalledTimes(listCallsAfterListing);
  });

  it('derives Pi mixed-message semantic roles from the canonical raw envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-public-ref-pi-roles-'));
    roots.add(root);
    const activeServerDir = join(root, 'server');
    const agentDir = join(root, '.pi', 'agent');
    const sessionRoot = join(agentDir, 'sessions', '--workspace--');
    const remoteSessionId = 'pi-public-ref-roles';
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(join(sessionRoot, `2026-08-10T10-00-00.000Z_${remoteSessionId}.jsonl`), [
      jsonl({ type: 'session', version: 3, id: remoteSessionId, timestamp: '2026-08-10T10:00:00.000Z', cwd: '/workspace' }),
      jsonl({ type: 'message', id: 'pi-public-ref-roles-user', parentId: null, timestamp: '2026-08-10T10:00:01.000Z', message: { role: 'user', content: 'Pi role projection' } }),
      jsonl({
        type: 'message',
        id: 'pi-public-ref-roles-assistant',
        parentId: 'pi-public-ref-roles-user',
        timestamp: '2026-08-10T10:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reasoning' },
            { type: 'text', text: 'answer' },
            { type: 'toolCall', id: 'pi-public-ref-roles-call', name: 'read', arguments: { path: '/workspace/a.ts' } },
          ],
        },
      }),
      jsonl({
        type: 'message',
        id: 'pi-public-ref-roles-result',
        parentId: 'pi-public-ref-roles-assistant',
        timestamp: '2026-08-10T10:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'pi-public-ref-roles-call',
          content: [{ type: 'text', text: 'file body' }],
        },
      }),
    ].join(''), 'utf8');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

    const realLeafAdapter = createRealLeafAdapter({
      agentId: 'pi',
      pluginId: 'happier.agent.pi',
      sourceId: 'piAgentDir:test',
      source: { kind: 'piAgentDir' },
      contribution: await registeredExternalSessionsContribution({ agentId: 'pi' }),
      activeServerDir,
    });
    const listed = await listUntilPublished(realLeafAdapter);
    const ref = listed.items[0]?.ref;
    if (!ref) throw new Error('expected Pi candidate ref');

    await expect(realLeafAdapter.adapter.authorService.readTranscript(ref)).resolves.toMatchObject({
      mode: 'page',
      items: [
        expect.objectContaining({ kind: 'user' }),
        expect.objectContaining({ kind: 'event' }),
        expect.objectContaining({ kind: 'agent' }),
        expect.objectContaining({ kind: 'event' }),
        expect.objectContaining({ kind: 'event' }),
      ],
    });
  });

  it('reads the shared-precedence OhMyPi winner across duplicate session roots using only its public ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-public-ref-ohmypi-'));
    roots.add(root);
    const activeServerDir = join(root, 'server');
    const agentDir = join(root, '.pi', 'agent');
    const remoteSessionId = 'ohmypi-public-ref';
    // Keep the older duplicate first so this public-ref read distinguishes the
    // shared candidate-precedence winner from a wrong first-root fallback.
    const olderRoot = join(agentDir, 'sessions', '-a-older-root');
    const newerRoot = join(agentDir, 'sessions', '-z-newer-root');
    await mkdir(olderRoot, { recursive: true });
    await mkdir(newerRoot, { recursive: true });
    const transcript = (timestamp: string, messageId: string, text: string) => [
      jsonl({ type: 'session', id: remoteSessionId, timestamp: '2026-08-10T10:00:00.000Z', cwd: '/workspace' }),
      jsonl({ type: 'message', id: messageId, parentId: null, timestamp, message: { role: 'user', content: text } }),
    ].join('');
    await writeFile(
      join(olderRoot, `2026-08-10T10-00-00.000Z_${remoteSessionId}.jsonl`),
      transcript('2026-08-10T10:01:00.000Z', 'older-user', 'older duplicate root'),
      'utf8',
    );
    await writeFile(
      join(newerRoot, `2026-08-10T11-00-00.000Z_${remoteSessionId}.jsonl`),
      transcript('2026-08-10T11:01:00.000Z', 'newer-user', 'newer shared-precedence winner'),
      'utf8',
    );
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

    const realLeafAdapter = createRealLeafAdapter({
      agentId: 'ohmypi',
      pluginId: 'happier.agent.ohmypi',
      sourceId: 'ohMyPiAgentDir:test',
      source: { kind: 'ohMyPiAgentDir' },
      contribution: await registeredExternalSessionsContribution({ agentId: 'ohmypi' }),
      activeServerDir,
    });
    const listed = await listUntilPublished(realLeafAdapter);
    expect(listed.items).toHaveLength(1);
    const ref = listed.items[0]?.ref;
    expect(ref).toEqual({
      agentId: 'ohmypi',
      sourceId: 'ohMyPiAgentDir:test',
      remoteSessionId,
    });
    expect(Object.keys(ref ?? {}).sort()).toEqual([
      'agentId',
      'remoteSessionId',
      'sourceId',
    ]);
    expect(JSON.stringify(listed)).not.toContain('sessionFilePath');

    const listCandidates = vi.mocked(realLeafAdapter.listCandidates);
    const listCallsAfterListing = listCandidates.mock.calls.length;
    await expect(realLeafAdapter.adapter.authorService.readTranscript(ref!)).resolves.toMatchObject({
      mode: 'page',
      items: [expect.objectContaining({
        kind: 'user',
        data: expect.objectContaining({ text: 'newer shared-precedence winner' }),
      })],
    });
    expect(listCandidates).toHaveBeenCalledTimes(listCallsAfterListing);
  });
});

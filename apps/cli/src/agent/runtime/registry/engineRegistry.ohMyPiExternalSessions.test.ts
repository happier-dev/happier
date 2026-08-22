import {
  appendFile,
  mkdir,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { executeExternalSessionCandidateQuery } from '@/session/actions/externalSessions/candidateQuery';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import { resolveExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const OH_MY_PI_AGENT_LOCAL_ID = 'ohmypi';
const OH_MY_PI_RUNTIME_AGENT_ID = 'ohMyPi';
const OH_MY_PI_PLUGIN_ID = 'happier.agent.ohmypi';

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('engineRegistry (Oh My Pi External Sessions)', () => {
  it('activates and invokes discover, link, page, and readAfter through the production catalog', async () => {
    await withTempDir('happier-ohmypi-external-consumer-', async (directory) => {
      const agentDir = join(directory, 'omp-agent');
      const sessionRoot = join(agentDir, 'sessions', '-workspace-');
      const remoteSessionId = 'omp-external-registry';
      const sessionFile = join(
        sessionRoot,
        `2026-07-25T10-00-00-000Z_${remoteSessionId}.jsonl`,
      );
      await mkdir(sessionRoot, { recursive: true });
      await writeFile(sessionFile, [
        line({
          type: 'session',
          version: 3,
          id: remoteSessionId,
          timestamp: '2026-07-25T10:00:00.000Z',
          cwd: '/workspace',
          title: 'Registered Oh My Pi session',
        }),
        line({
          type: 'message',
          id: 'omp-registry-user',
          parentId: null,
          timestamp: '2026-07-25T10:00:01.000Z',
          message: { role: 'user', content: 'registered prompt' },
        }),
        line({
          type: 'compaction',
          id: 'omp-registry-compaction',
          parentId: 'omp-registry-user',
          timestamp: '2026-07-25T10:00:02.000Z',
          summary: 'registered compacted context',
        }),
      ].join(''), 'utf8');

      const envScope = createEnvKeyScope(['PI_CODING_AGENT_DIR']);
      envScope.patch({ PI_CODING_AGENT_DIR: agentDir });
      let runtimeRegistry:
        | Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>
        | null = null;
      try {
        runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
          contributes: createResolvedContributionRegistry(resolveBuiltInContributions()),
          happyHomeDir: join(directory, 'home'),
          pluginIds: [OH_MY_PI_PLUGIN_ID],
        });

        expect(runtimeRegistry.targetActivationFacts).toEqual(expect.arrayContaining([
          expect.objectContaining({
            pluginId: OH_MY_PI_PLUGIN_ID,
            status: 'active',
            required: expect.arrayContaining([
              expect.objectContaining({
                family: 'agents',
                localId: OH_MY_PI_AGENT_LOCAL_ID,
              }),
            ]),
            bound: expect.arrayContaining([
              expect.objectContaining({
                family: 'agents',
                localId: OH_MY_PI_AGENT_LOCAL_ID,
              }),
            ]),
            diagnostics: [],
          }),
        ]));
        expect(runtimeRegistry.agentRuntimesByAgentId.get(OH_MY_PI_RUNTIME_AGENT_ID)).toMatchObject({
          pluginId: OH_MY_PI_PLUGIN_ID,
          agentId: OH_MY_PI_RUNTIME_AGENT_ID,
          hasPrimaryRuntime: true,
          externalSessions: expect.any(Object),
          externalSessionObservation: expect.objectContaining({
            describeResource: expect.any(Function),
            observeResource: expect.any(Function),
            reconcileResource: expect.any(Function),
          }),
        });

        const resolution = await resolveBackendEngineAdapterResolution(
          'ohMyPi',
          { runtimeRegistry },
        );
        const externalSession = resolution?.executionSurfaces.externalSession;
        expect(externalSession).toEqual(expect.objectContaining({
          validateSource: expect.any(Function),
          listCandidates: expect.any(Function),
          resolveLinkIdentity: expect.any(Function),
          canonicalizeLinkedSession: expect.any(Function),
          pageTranscript: expect.any(Function),
          readAfterTranscript: expect.any(Function),
        }));
        expect(resolution?.executionSurfaces.terminalRuntime).toBeNull();
        if (!externalSession) {
          throw new Error('Expected Oh My Pi External Sessions execution surface');
        }

        const source = { kind: 'ohMyPiAgentDir', agentDir } as never;
        const queryCandidates = async () => await executeExternalSessionCandidateQuery({
          activeServerDir: join(directory, 'active-server'),
          agentIdentity: {
            pluginId: OH_MY_PI_PLUGIN_ID,
            localId: OH_MY_PI_AGENT_LOCAL_ID,
          },
          source,
          limit: 10,
          listCandidates: async (request) => externalSession.listCandidates!({
            source,
            limit: request.limit,
            ...(request.cursor ? { cursor: request.cursor } : {}),
          }),
        });
        let queried = await queryCandidates();
        for (let attempt = 0; queried.preparation && attempt < 3; attempt += 1) {
          queried = await queryCandidates();
        }
        expect(queried.preparation).toBeUndefined();
        expect(queried).toMatchObject({
          candidates: [{
            remoteSessionId,
            linkData: {
              sessionFilePath: expect.stringContaining(`${remoteSessionId}.jsonl`),
            },
            candidateKey: expect.stringMatching(/^[a-f0-9]{64}$/),
          }],
          nextCursor: null,
        });
        const candidate = queried.candidates[0];
        if (!candidate?.linkData) {
          throw new Error('Expected source-qualified Oh My Pi candidate');
        }

        const linked = await externalSession.resolveLinkIdentity!({
          source,
          remoteSessionId: candidate.remoteSessionId,
          metadata: { linkData: candidate.linkData },
        });
        expect(linked).toMatchObject({
          source: {
            kind: 'ohMyPiAgentDir',
            agentDir: expect.any(String),
            sessionFilePath: expect.stringContaining(`${remoteSessionId}.jsonl`),
          },
          remoteSessionId,
          externalSessionMetadata: { linkData: {} },
        });
        // The host projects only Agent-owned native-session facts out of a link
        // identity into TOP-LEVEL session owner metadata, whose strict allow-list
        // rejects unknown keys with a typed-error-less failure.
        expect(linked.vendorMetadata).toEqual({});

        const page = await externalSession.pageTranscript!({
          source: linked.source,
          remoteSessionId: linked.remoteSessionId,
          direction: 'older',
          maxBytes: 64 * 1024,
          maxItems: 10,
        });
        expect(page.items.map((item) => item.id)).toEqual([
          expect.stringContaining(':omp-registry-user'),
          expect.stringContaining(':omp-registry-compaction:compaction'),
        ]);
        expect(page.tailCursor).toMatch(/^happier_external_cursor_v1:/);

        await appendFile(sessionFile, line({
          type: 'message',
          id: 'omp-registry-assistant',
          parentId: 'omp-registry-compaction',
          timestamp: '2026-07-25T10:00:03.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'registered answer' }],
          },
        }));
        const advanced = await externalSession.readAfterTranscript!({
          source: linked.source,
          remoteSessionId: linked.remoteSessionId,
          cursor: page.tailCursor!,
          maxBytes: 64 * 1024,
          maxItems: 10,
        });
        expect(advanced).toMatchObject({
          outcome: 'advanced',
          items: [{
            id: expect.stringContaining(':omp-registry-assistant:text:0'),
            raw: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'ohMyPi',
                data: {
                  type: 'message',
                  message: 'registered answer',
                },
              },
            },
          }],
          nextCursor: expect.stringMatching(/^happier_external_cursor_v1:/),
          boundary: expect.any(String),
        });
      } finally {
        await runtimeRegistry?.dispose();
        envScope.restore();
      }
    });
  });
});

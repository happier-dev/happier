import {
  appendFile,
  mkdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import { buildPiRpcArgs } from '@happier-dev/plugins-pi/agent/runtime/rpc/args';
import { describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { executeExternalSessionCandidateQuery } from '@/session/actions/externalSessions/candidateQuery';
import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import { resolveExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const PI_AGENT_ID = 'pi';
const PI_PLUGIN_ID = 'happier.agent.pi';

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('engineRegistry (Pi External Sessions)', () => {
  it('activates and invokes discover, link, page, and readAfter through the production catalog', async () => {
    await withTempDir('happier-pi-external-consumer-', async (directory) => {
      const agentDir = join(directory, 'pi-agent');
      const sessionRoot = join(agentDir, 'sessions', '--workspace--');
      const sessionFile = join(
        sessionRoot,
        '2026-07-23T10-00-00-000Z_pi-external-registry.jsonl',
      );
      await mkdir(sessionRoot, { recursive: true });
      await writeFile(sessionFile, [
        line({
          type: 'session',
          version: 3,
          id: 'pi-external-registry',
          timestamp: '2026-07-23T10:00:00.000Z',
          cwd: '/workspace',
        }),
        line({
          type: 'message',
          id: 'pi-registry-user',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'registered prompt' },
        }),
        line({
          type: 'session_info',
          id: 'pi-registry-title',
          parentId: 'pi-registry-user',
          timestamp: '2026-07-23T10:00:02.000Z',
          name: 'Registered Pi session',
        }),
      ].join(''), 'utf8');
      const canonicalSessionFile = await realpath(sessionFile);

      const envScope = createEnvKeyScope(['PI_CODING_AGENT_DIR']);
      envScope.patch({ PI_CODING_AGENT_DIR: agentDir });
      let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
      try {
        runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
          contributes: createResolvedContributionRegistry(resolveBuiltInContributions()),
          happyHomeDir: join(directory, 'home'),
          pluginIds: [PI_PLUGIN_ID],
        });

        expect(runtimeRegistry.targetActivationFacts).toEqual(expect.arrayContaining([
          expect.objectContaining({
            pluginId: PI_PLUGIN_ID,
            status: 'active',
            required: expect.arrayContaining([
              expect.objectContaining({
                family: 'agents',
                localId: PI_AGENT_ID,
                requiredFields: ['factory', 'externalSessions'],
              }),
            ]),
            bound: expect.arrayContaining([
              expect.objectContaining({ family: 'agents', localId: PI_AGENT_ID }),
            ]),
            diagnostics: [],
          }),
        ]));
        expect(runtimeRegistry.agentRuntimesByAgentId.get(PI_AGENT_ID)).toMatchObject({
          pluginId: PI_PLUGIN_ID,
          agentId: PI_AGENT_ID,
          hasPrimaryRuntime: true,
          externalSessions: expect.any(Object),
          externalSessionObservation: expect.objectContaining({
            describeResource: expect.any(Function),
            observeResource: expect.any(Function),
            reconcileResource: expect.any(Function),
          }),
        });

        const resolution = await resolveBackendEngineAdapterResolution(PI_AGENT_ID, {
          runtimeRegistry,
        });
        const externalSession = resolution?.executionSurfaces.externalSession;
        expect(externalSession).toEqual(expect.objectContaining({
          validateSource: expect.any(Function),
          listCandidates: expect.any(Function),
          resolveLinkIdentity: expect.any(Function),
          canonicalizeLinkedSession: expect.any(Function),
          pageTranscript: expect.any(Function),
          readAfterTranscript: expect.any(Function),
        }));
        if (!externalSession) throw new Error('Expected Pi External Sessions execution surface');

        const source = { kind: 'piAgentDir' } as never;
        const candidates = await externalSession.listCandidates!({
          source,
          limit: 1,
        });
        expect(candidates).toMatchObject({
          candidates: [{
            remoteSessionId: 'pi-external-registry',
            title: 'Registered Pi session',
            linkData: { sessionFile: expect.stringContaining('pi-external-registry.jsonl') },
          }],
          nextCursor: null,
        });
        const activeServerDir = join(directory, 'active-server');
        const queriedCandidates = await executeExternalSessionCandidateQuery({
          activeServerDir,
          agentIdentity: {
            pluginId: PI_PLUGIN_ID,
            localId: PI_AGENT_ID,
          },
          source,
          limit: 1,
          listCandidates: async (request) => externalSession.listCandidates!({
            source,
            limit: request.limit,
            ...(request.cursor ? { cursor: request.cursor } : {}),
          }),
        });
        expect(queriedCandidates).toEqual({
          candidates: candidates.candidates.map((candidate) => ({
            ...candidate,
            candidateKey: expect.stringMatching(/^[a-f0-9]{64}$/),
          })),
          nextCursor: candidates.nextCursor,
        });
        expect(queriedCandidates).not.toHaveProperty('preparation');
        await expect(stat(join(
          activeServerDir,
          'external-sessions',
          'indexes',
        ))).rejects.toMatchObject({ code: 'ENOENT' });
        const candidate = candidates.candidates[0];
        if (!candidate?.linkData) throw new Error('Expected source-qualified Pi candidate');

        const linked = await externalSession.resolveLinkIdentity!({
          source,
          remoteSessionId: candidate.remoteSessionId,
          metadata: {
            linkData: candidate.linkData,
          },
        });
        expect(linked).toMatchObject({
          source: {
            kind: 'piAgentDir',
            agentDir: expect.any(String),
            sessionFile: canonicalSessionFile,
          },
          remoteSessionId: 'pi-external-registry',
          runtimeDescriptor: {
            v: 1,
            agentId: PI_AGENT_ID,
            agent: {
              resumeStrategy: 'sessionFileAbsolutePreferred',
              providerSessionId: 'pi-external-registry',
              sessionFile: canonicalSessionFile,
            },
          },
          externalSessionMetadata: {
            linkData: {
              sessionFile: canonicalSessionFile,
              runtimeDescriptorV1: {
                v: 1,
                agentId: PI_AGENT_ID,
                agent: {
                  resumeStrategy: 'sessionFileAbsolutePreferred',
                  providerSessionId: 'pi-external-registry',
                  sessionFile: canonicalSessionFile,
                },
              },
            },
          },
        });
        const resumeSessionId = resolveVendorResumeIdFromSessionMetadata(PI_AGENT_ID, {
          piSessionId: linked.remoteSessionId,
          runtimeDescriptorV1: linked.runtimeDescriptor,
        });
        expect(resumeSessionId).toBe(canonicalSessionFile);
        expect(buildPiRpcArgs({ resumeSessionId }).slice(-2)).toEqual([
          '--session',
          canonicalSessionFile,
        ]);

        const page = await externalSession.pageTranscript!({
          source: linked.source,
          remoteSessionId: linked.remoteSessionId,
          direction: 'older',
          maxBytes: 64 * 1024,
          maxItems: 10,
        });
        expect(page.items.map((item) => item.raw.record)).toEqual([
          expect.objectContaining({ id: 'pi-registry-user' }),
        ]);
        expect(page.tailCursor).toMatch(/^happier_external_cursor_v1:/);

        await appendFile(sessionFile, line({
          type: 'message',
          id: 'pi-registry-assistant',
          parentId: 'pi-registry-title',
          timestamp: '2026-07-23T10:00:03.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'registered answer' }] },
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
            raw: {
              record: expect.objectContaining({ id: 'pi-registry-assistant' }),
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

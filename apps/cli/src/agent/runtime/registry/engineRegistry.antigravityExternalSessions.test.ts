import {
  appendFile,
  mkdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { executeExternalSessionCandidateQuery } from '@/session/actions/externalSessions/candidateQuery';
import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import { resolveExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const ANTIGRAVITY_AGENT_ID = 'antigravity';
const ANTIGRAVITY_PLUGIN_ID = 'happier.agent.antigravity';

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('engineRegistry (Antigravity External Sessions)', () => {
  it('activates and invokes discover, link, page, and readAfter through the production catalog', async () => {
    await withTempDir('happier-antigravity-external-consumer-', async (directory) => {
      const home = join(directory, 'home');
      const conversationId = 'antigravity-external-registry';
      const transcriptDir = join(
        home,
        '.gemini',
        'antigravity-cli',
        'brain',
        conversationId,
        '.system_generated',
        'logs',
      );
      const transcriptPath = join(transcriptDir, 'transcript_full.jsonl');
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(transcriptPath, [
        line({
          step_index: 1,
          type: 'USER_INPUT',
          text: 'registered prompt',
          created_at: '2026-07-23T10:00:00.000Z',
        }),
        line({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          text: 'registered answer',
          created_at: '2026-07-23T10:00:01.000Z',
        }),
      ].join(''), 'utf8');

      const envScope = createEnvKeyScope(['HOME', 'USERPROFILE']);
      envScope.patch({ HOME: home, USERPROFILE: undefined });
      let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
      try {
        runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
          contributes: createResolvedContributionRegistry(resolveBuiltInContributions()),
          happyHomeDir: join(directory, 'happier-home'),
          pluginIds: [ANTIGRAVITY_PLUGIN_ID],
        });

        expect(runtimeRegistry.targetActivationFacts).toEqual(expect.arrayContaining([
          expect.objectContaining({
            pluginId: ANTIGRAVITY_PLUGIN_ID,
            status: 'active',
            required: expect.arrayContaining([
              expect.objectContaining({
                family: 'agents',
                localId: ANTIGRAVITY_AGENT_ID,
              }),
            ]),
            bound: expect.arrayContaining([
              expect.objectContaining({
                family: 'agents',
                localId: ANTIGRAVITY_AGENT_ID,
              }),
            ]),
            diagnostics: [],
          }),
        ]));
        expect(runtimeRegistry.agentRuntimesByAgentId.get(ANTIGRAVITY_AGENT_ID)).toMatchObject({
          pluginId: ANTIGRAVITY_PLUGIN_ID,
          agentId: ANTIGRAVITY_AGENT_ID,
          hasPrimaryRuntime: true,
          externalSessions: expect.any(Object),
        });

        const resolution = await resolveBackendEngineAdapterResolution(
          ANTIGRAVITY_AGENT_ID,
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
        if (!externalSession) {
          throw new Error('Expected Antigravity External Sessions execution surface');
        }

        const source = { kind: 'antigravityCliPrint' } as never;
        const candidates = await externalSession.listCandidates!({
          source,
          limit: 2,
        });
        expect(candidates).toMatchObject({
          candidates: [{
            remoteSessionId: conversationId,
            linkData: { sourceRevision: expect.any(String) },
          }],
          nextCursor: null,
        });
        const candidate = candidates.candidates[0];
        if (!candidate?.linkData) {
          throw new Error('Expected source-qualified Antigravity candidate');
        }

        const linked = await externalSession.resolveLinkIdentity!({
          source,
          remoteSessionId: candidate.remoteSessionId,
          metadata: {
            linkData: candidate.linkData,
          },
        });
        expect(linked).toMatchObject({
          source: {
            kind: 'antigravityCliPrint',
            brainDir: expect.any(String),
            conversationId,
            sourceRevision: expect.any(String),
          },
          remoteSessionId: conversationId,
        });
        // The transcript revision is canonical on the resolved source; projecting it as
        // vendor metadata would be rejected by the session-metadata owner allow-list.
        expect(linked.vendorMetadata).toEqual({});
        expect(linked.externalSessionMetadata).toEqual({ linkData: {} });

        const page = await externalSession.pageTranscript!({
          source: linked.source,
          remoteSessionId: linked.remoteSessionId,
          direction: 'older',
          maxBytes: 64 * 1024,
          maxItems: 10,
        });
        expect(page.items).toEqual([
          expect.objectContaining({
            messageRole: 'user',
            raw: {
              role: 'user',
              content: { type: 'text', text: 'registered prompt' },
            },
          }),
          expect.objectContaining({
            messageRole: 'agent',
            raw: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: ANTIGRAVITY_AGENT_ID,
                data: { type: 'message', message: 'registered answer' },
              },
            },
          }),
        ]);
        expect(page.tailCursor).toMatch(/^happier_external_cursor_v1:/);

        await appendFile(transcriptPath, line({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          text: 'registered follow-up',
          created_at: '2026-07-23T10:00:02.000Z',
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
            messageRole: 'agent',
            raw: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: ANTIGRAVITY_AGENT_ID,
                data: { type: 'message', message: 'registered follow-up' },
              },
            },
          }],
          nextCursor: expect.stringMatching(/^happier_external_cursor_v1:/),
          boundary: expect.any(String),
        });

        await Promise.all(Array.from({ length: 55 }, async (_, index) => {
          const candidateTranscriptDir = join(
            home,
            '.gemini',
            'antigravity-cli',
            'brain',
            `candidate-${String(index).padStart(3, '0')}`,
            '.system_generated',
            'logs',
          );
          await mkdir(candidateTranscriptDir, { recursive: true });
          await writeFile(
            join(candidateTranscriptDir, 'transcript_full.jsonl'),
            line({ id: `candidate-${index}`, type: 'USER_INPUT', text: `candidate ${index}` }),
            'utf8',
          );
        }));
        const directQuery = (cursor?: string) => executeExternalSessionCandidateQuery({
          activeServerDir: join(directory, 'active-server'),
          agentIdentity: {
            pluginId: ANTIGRAVITY_PLUGIN_ID,
            localId: ANTIGRAVITY_AGENT_ID,
          },
          source,
          limit: 5,
          ...(cursor ? { cursor } : {}),
          listCandidates: async (request) => externalSession.listCandidates!({
            source,
            limit: request.limit,
            ...(request.cursor ? { cursor: request.cursor } : {}),
          }),
        });
        const firstDirectPage = await directQuery();
        expect(firstDirectPage).toMatchObject({
          candidates: expect.arrayContaining([
            expect.objectContaining({
              remoteSessionId: expect.stringMatching(/^(candidate-\d{3}|antigravity-external-registry)$/),
            }),
          ]),
          nextCursor: expect.any(String),
        });
        expect(firstDirectPage.candidates).toHaveLength(5);
        expect(firstDirectPage).not.toHaveProperty('preparation');

        const completeCandidateSet = [...firstDirectPage.candidates];
        let directCursor = firstDirectPage.nextCursor;
        while (directCursor) {
          const page = await directQuery(directCursor);
          expect(page.candidates.length).toBeLessThanOrEqual(5);
          expect(page).not.toHaveProperty('preparation');
          completeCandidateSet.push(...page.candidates);
          directCursor = page.nextCursor;
        }
        expect(completeCandidateSet).toHaveLength(56);
        expect(new Set(
          completeCandidateSet.map((candidateItem) => candidateItem.remoteSessionId),
        ).size).toBe(56);
        await expect(stat(join(
          directory,
          'active-server',
          'external-sessions',
          'indexes',
        ))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await runtimeRegistry?.dispose();
        envScope.restore();
      }
    });
  });
});

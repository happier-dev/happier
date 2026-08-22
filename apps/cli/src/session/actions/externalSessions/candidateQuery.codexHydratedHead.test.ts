import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ExternalSessionsSource } from '@happier-dev/protocol';

import type { ExternalSessionCandidatesPage } from '@/session/external/providerOps';

import {
    executeExternalSessionCandidateQuery,
    hydrateExternalSessionCandidateThroughAgentSource,
} from './candidateQuery';

type CodexListing = (params: Record<string, unknown>) => Promise<ExternalSessionCandidatesPage>;

const roots: string[] = [];

function jsonl(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

async function writeRollout(params: Readonly<{
    sessionsDir: string;
    remoteSessionId: string;
    stamp: string;
    cwd: string;
    userText: string;
}>): Promise<void> {
    await mkdir(params.sessionsDir, { recursive: true });
    await writeFile(
        join(params.sessionsDir, `rollout-${params.stamp}-${params.remoteSessionId}.jsonl`),
        [
            jsonl({
                type: 'session_meta',
                timestamp: '2026-08-01T08:00:00.000Z',
                payload: {
                    id: params.remoteSessionId,
                    timestamp: '2026-08-01T08:00:00.000Z',
                    cwd: params.cwd,
                },
            }),
            jsonl({
                type: 'response_item',
                timestamp: '2026-08-01T08:00:01.000Z',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: params.userText }],
                },
            }),
        ].join(''),
        'utf8',
    );
}

describe('Codex candidate index head', () => {
    afterEach(async () => {
        await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
    });

    it('serves a hydrated head carrying titles for an unsearched Codex browse', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-index-head-'));
        roots.push(root);
        const codexHome = join(root, 'codex-home');
        const activeServerDir = join(root, 'active-server');
        const sessionsDir = join(codexHome, 'sessions', '2026', '08', '01');
        const remoteSessionIds = [
            '11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222',
            '33333333-3333-3333-3333-333333333333',
        ] as const;
        const titles = [
            'Audit the transcript corridor',
            'Fix the candidate index head',
            'Measure rollout scan latency',
        ] as const;
        for (const [index, remoteSessionId] of remoteSessionIds.entries()) {
            await writeRollout({
                sessionsDir,
                remoteSessionId,
                stamp: `2026-08-01T0${index + 1}-00-00`,
                cwd: `/repo/codex-${index}`,
                userText: titles[index]!,
            });
        }

        const codexExternalDir = '../../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external';
        const { listCodexSessionCandidates } = await import(
            `${codexExternalDir}/candidateSource.js`
        ) as { listCodexSessionCandidates: CodexListing };
        const { resolveCodexExternalSessionLinkIdentity } = await import(
            `${codexExternalDir}/identity.js`
        ) as {
            resolveCodexExternalSessionLinkIdentity: (
                params: Record<string, unknown>,
            ) => Readonly<{ remoteSessionId: string }>;
        };

        const codexSource = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;
        const source = codexSource as unknown as ExternalSessionsSource;
        const env = { ...process.env, CODEX_HOME: codexHome } as NodeJS.ProcessEnv;
        const listCandidates = async (request: Readonly<{
            cursor?: string;
            limit: number;
            searchTerm?: string;
            searchMode?: 'fast' | 'full';
        }>): Promise<ExternalSessionCandidatesPage> => await listCodexSessionCandidates({
            source: codexSource,
            activeServerDir,
            env,
            ...request,
            signal: new AbortController().signal,
            deadlineAtMs: Date.now() + 60_000,
        });
        const providerOps = {
            listCandidates: async (params: Readonly<{
                cursor?: string;
                limit: number;
                searchTerm?: string;
                searchMode?: 'fast' | 'full';
            }>) => await listCandidates(params),
            resolveLinkIdentity: async (params: Readonly<{ remoteSessionId: string }>) => {
                const identity = resolveCodexExternalSessionLinkIdentity({
                    source: codexSource,
                    remoteSessionId: params.remoteSessionId,
                });
                return { remoteSessionId: identity.remoteSessionId, source };
            },
        };

        let page: ExternalSessionCandidatesPage | null = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
            page = await executeExternalSessionCandidateQuery({
                activeServerDir,
                agentIdentity: {
                    pluginId: 'codex',
                    contributionId: 'codex',
                    pluginGeneration: 'codex-index-head-1',
                } as never,
                source,
                limit: 50,
                listCandidates,
                hydrateCandidate: async (candidate) => (
                    await hydrateExternalSessionCandidateThroughAgentSource({
                        source,
                        candidate,
                        providerOps: providerOps as never,
                    })
                ),
            });
            if (!page.preparation) break;
        }

        expect(page?.preparation).toBeUndefined();
        expect(page?.candidates.map((candidate) => candidate.remoteSessionId).sort())
            .toEqual([...remoteSessionIds].sort());
        expect(page?.candidates.map((candidate) => candidate.title).sort())
            .toEqual([...titles].sort());
    }, 120_000);
});

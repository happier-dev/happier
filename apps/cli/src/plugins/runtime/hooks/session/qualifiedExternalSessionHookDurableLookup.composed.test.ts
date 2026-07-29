import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    buildLinkedExternalSessionMetadataV1,
    resolveExternalSessionsSourceKey,
    resolveExternalSessionsSourceKeysForPersistedTagLookup,
} from '@happier-dev/protocol';
import { codexExternalSessionsContribution } from '@happier-dev/plugins-codex';

import {
    resolveExternalSessionTagLookupCandidates,
} from '@/api/session/external/linking/externalSessionTagLookupCandidates';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const { readCredentialsMock } = vi.hoisted(() => ({
    readCredentialsMock: vi.fn(),
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readCredentials: readCredentialsMock,
}));

import {
    resolveDurableCurrentLink,
} from './qualifiedExternalSessionHookDaemonIngress';

let codexHome = '';
let priorCodexHome: string | undefined;
const source = () => ({
    kind: 'codexHome' as const,
    home: 'user' as const,
    homePath: codexHome,
});
const qualifiedIdentity = {
    v: 1 as const,
    agent: {
        pluginId: 'happier.agent.codex',
        localId: 'codex',
    },
    source: {
        kind: 'codexHome',
        contractVersion: 1 as const,
    },
};

describe('qualified External Session hook durable lookup composition', () => {
    let runtimeRegistryLease: PluginRuntimeRegistryLease | null = null;

    beforeAll(async () => {
        codexHome = await mkdtemp(join(tmpdir(), 'hook-tag-lookup-codex-'));
        const sessionsDir = join(codexHome, 'sessions', '2026', '07', '25');
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(
            join(
                sessionsDir,
                'rollout-2026-07-25T12-00-00-thread-1.jsonl',
            ),
            JSON.stringify({
                type: 'session_meta',
                payload: { id: 'thread-1' },
            }),
            'utf8',
        );
        priorCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = codexHome;
        runtimeRegistryLease =
            await pluginReloadController.acquireRuntimeRegistry({
                resolveRuntimeRegistry: async () =>
                    await resolveExecutablePluginRuntimeRegistry({
                        contributes: getResolvedContributionRegistry(),
                        pluginIds: [
                            'happier.agent.claude',
                            'happier.agent.codex',
                            'happier.agent.ohmypi',
                            'happier.agent.opencode',
                        ],
                    }),
            });
    });

    afterAll(async () => {
        runtimeRegistryLease?.release();
        runtimeRegistryLease = null;
        await pluginReloadController.shutdown({ timeoutMs: 5_000 });
        if (priorCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = priorCodexHome;
        }
        await rm(codexHome, { recursive: true, force: true });
    });

    beforeEach(() => {
        vi.restoreAllMocks();
        readCredentialsMock.mockResolvedValue({
            token: 'token-1',
            encryption: {
                type: 'legacy',
                secret: new Uint8Array(32).fill(1),
            },
        });
    });

    it('uses the real tag, plaintext metadata, current Agent identity, and observation owners', async () => {
        const resolvedSource = source();
        const signal = new AbortController().signal;
        const linkedIdentity =
            await codexExternalSessionsContribution.resolveLinkIdentity({
                source: resolvedSource,
                remoteSessionId: 'thread-1',
                signal,
                deadlineAtMs: Date.now() + 500,
                maxSerializedBytes: 262_144,
            });
        if (!linkedIdentity.ok) {
            throw new Error('Expected the real Codex linked identity');
        }
        const tag = resolveExternalSessionTagLookupCandidates({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'thread-1',
            source: linkedIdentity.value.source,
            releasedPersistedSource: linkedIdentity.value.source,
            sourceKey: resolveExternalSessionsSourceKey(
                linkedIdentity.value.source,
            ),
            releasedSourceKeys:
                resolveExternalSessionsSourceKeysForPersistedTagLookup(
                    linkedIdentity.value.source,
                ),
        })[0].tag;
        const metadata = buildLinkedExternalSessionMetadataV1(
            {
                tag,
                path: '/tmp/project',
            },
            {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'thread-1',
                source: linkedIdentity.value.source,
                linkedAtMs: 123,
                qualifiedIdentity,
                linkData: linkedIdentity.value.linkData,
            },
        );
        const rawSession = createSessionRecordFixture({
            id: 'session-1',
            encryptionMode: 'plain',
            metadata: JSON.stringify(metadata),
            currentStorageState: 'machine_only',
            metadataVersion: 1,
            agentStateVersion: 0,
        });
        vi.spyOn(axios, 'post').mockResolvedValue({
            status: 200,
            data: { sessions: [rawSession] },
        } as any);
        const resolved = await resolveDurableCurrentLink({
            machineId: 'machine-1',
            agentId: 'codex',
            identity: {
                qualifiedIdentity,
                source: linkedIdentity.value.source,
                remoteSessionId: 'thread-1',
                linkData: linkedIdentity.value.linkData,
            },
            signal,
            deadlineAtMs: Date.now() + 500,
        });
        expect(axios.post).toHaveBeenCalledOnce();
        expect(axios.post).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/lookup-by-tags'),
            { tags: [tag] },
            expect.objectContaining({ signal }),
        );
        expect(resolved).toMatchObject({
            link: {
                sessionId: 'session-1',
                linkGeneration: '123',
                linkedSource: {
                    source: linkedIdentity.value.source,
                    remoteSessionId: 'thread-1',
                },
            },
            target: {
                qualifiedLinkIdentity: qualifiedIdentity,
                linkGeneration: '123',
            },
        });
    });
});

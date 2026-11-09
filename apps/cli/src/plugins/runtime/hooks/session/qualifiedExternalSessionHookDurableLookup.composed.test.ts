import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    resolveExternalSessionsSourceKey,
    resolveExternalSessionsSourceKeysForPersistedTagLookup,
} from '@happier-dev/protocol';
import { codexExternalSessionsContribution } from '@happier-dev/plugins-codex';
import type {
    AgentExternalSessionsManagedEndpointRead,
    AgentExternalSessionsRipgrep,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
    resolveExternalSessionTagLookupCandidates,
} from '@/api/session/external/linking/externalSessionTagLookupCandidates';
import { configuration } from '@/configuration';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { buildExternalSessionMetadata, resolveExternalSessionIndexedTagLookup } from '@/api/session/external/linking/ensureExternalSessionLink';
import { resolveExternalSessionSourceKeyOwner } from '@/session/actions/externalSessions/providerOpsResolution';

const {
    fetchAccountEncryptionCurrentnessMock,
    readCredentialsMock,
    readStoredCredentialsMock,
} = vi.hoisted(() => ({
    fetchAccountEncryptionCurrentnessMock: vi.fn(),
    readCredentialsMock: vi.fn(),
    readStoredCredentialsMock: vi.fn(),
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
    fetchAccountEncryptionCurrentness: fetchAccountEncryptionCurrentnessMock,
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readCredentials: readCredentialsMock,
    readStoredCredentials: readStoredCredentialsMock,
}));

import {
    resolveDurableCurrentLink,
} from './qualifiedExternalSessionHookDaemonIngress';

let codexHome = '';
let priorCodexHome: string | undefined;
const unavailableManagedEndpointRead: AgentExternalSessionsManagedEndpointRead =
    async () => {
        throw new Error('Managed endpoint read is unavailable in this file-backed fixture');
    };
const unavailableInvocationExec = createUnavailablePluginServices().exec;
const unavailableRipgrep: AgentExternalSessionsRipgrep = {
    run: async () => { throw new Error('Ripgrep is unavailable in this exact file-backed identity fixture'); },
};
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
    let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;

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
        runtimeFixture = await createAdmittedPluginRuntimeFixture({
            happyHomeDir: configuration.happyHomeDir,
            controller: pluginReloadController,
            runtimeOptions: {
                pluginIds: [
                    'happier.agent.claude',
                    'happier.agent.codex',
                    'happier.agent.ohmypi',
                    'happier.agent.opencode',
                ],
            },
        });
    });

    afterAll(async () => {
        await runtimeFixture?.dispose();
        runtimeFixture = null;
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
        fetchAccountEncryptionCurrentnessMock.mockReset().mockResolvedValue({
            mode: 'plain',
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
        });
        readCredentialsMock.mockResolvedValue(null);
        readStoredCredentialsMock.mockResolvedValue({
            token: 'token-1',
            encryption: null,
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
                managedEndpointRead: unavailableManagedEndpointRead,
                exec: unavailableInvocationExec,
                ripgrep: unavailableRipgrep,
            });
        if (!linkedIdentity.ok) {
            throw new Error('Expected the real Codex linked identity');
        }
        const tagCandidates = resolveExternalSessionTagLookupCandidates({
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
        });
        const tag = tagCandidates[0].tag;
        const metadata = buildExternalSessionMetadata({
            tag, directoryHint: '/tmp/project', agentId: 'codex', machineId: 'machine-1',
            remoteSessionId: 'thread-1', source: linkedIdentity.value.source, nowMs: 123, qualifiedIdentity,
            externalSessionMetadata: { linkData: linkedIdentity.value.linkData },
        });
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
        const startedAtMs = Date.now();
        const deadlineAtMs = startedAtMs + 500;
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
            deadlineAtMs,
        });
        const finishedAtMs = Date.now();
        expect(axios.post).toHaveBeenCalledOnce();
        expect(fetchAccountEncryptionCurrentnessMock).toHaveBeenCalledOnce();
        expect(fetchAccountEncryptionCurrentnessMock).toHaveBeenCalledWith({
            credentials: expect.objectContaining({ token: 'token-1' }),
            token: 'token-1',
            signal,
        });
        expect(readStoredCredentialsMock).toHaveBeenCalledOnce();
        expect(readCredentialsMock).not.toHaveBeenCalled();
        expect(axios.post).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/lookup-by-tags'),
            { tags: [tag] },
            expect.objectContaining({ signal }),
        );
        const sourceKeyOwner = await resolveExternalSessionSourceKeyOwner('codex', linkedIdentity.value.source);
        if (!sourceKeyOwner) throw new Error('Expected a current source-key owner');
        expect(await resolveExternalSessionIndexedTagLookup({
            credentials: { token: 'token-1', encryption: null }, accountEncryptionMode: 'plain',
            machineId: 'machine-1', agentId: 'codex', remoteSessionId: 'thread-1', source: linkedIdentity.value.source,
            tagCandidates, resolveSourceKey: sourceKeyOwner.resolveSourceKey,
            proof: { state: 'available', tags: [tag], sessions: [rawSession] },
        })).toMatchObject({ state: 'available', existing: { kind: 'external_link' } });
        expect(resolved, JSON.stringify({ elapsedMs: finishedAtMs - startedAtMs, deadlineExpired: finishedAtMs >= deadlineAtMs })).toMatchObject({
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

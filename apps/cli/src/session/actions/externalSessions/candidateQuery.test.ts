import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExternalSessionProviderFailureError } from '@/session/external/providerOps';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';

import {
    executeExternalSessionCandidateQuery as executeExternalSessionCandidateQueryOwner,
    hydrateExternalSessionCandidateThroughAgentSource,
    resolveExternalSessionCandidateIdentityKey,
} from './candidateQuery';

const TEST_SOURCE_CUSTODY = Object.freeze({
    kind: 'development' as const,
    registeredRootId: 'candidate-query-test-root',
});

function executeExternalSessionCandidateQuery(
    params: Omit<Parameters<typeof executeExternalSessionCandidateQueryOwner>[0], 'agentSourceCustody'>
        & Partial<Pick<Parameters<typeof executeExternalSessionCandidateQueryOwner>[0], 'agentSourceCustody'>>,
) {
    return executeExternalSessionCandidateQueryOwner({
        ...params,
        agentSourceCustody: params.agentSourceCustody ?? TEST_SOURCE_CUSTODY,
    });
}

const roots: string[] = [];

/** Files the host keeps for this Agent/source (checkpoint store, retired index files). */
async function countCandidateIndexFiles(activeServerDir: string): Promise<number> {
    let found = 0;
    const walk = async (directory: string): Promise<void> => {
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.isDirectory()) await walk(join(directory, entry.name));
            else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) found += 1;
        }
    };
    await walk(join(activeServerDir, 'external-sessions', 'candidate-indexes', 'v1'));
    return found;
}

describe('External Sessions candidate query owner', () => {
    it('omits managed Session workspaces while retaining ordinary directories and the native continuation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-candidates-'));
        roots.push(root);
        const managed = createManagedSessionDirectories({ activeServerDir: root }).prepareForCreation({ sessionCreationTag: 'managed' });
        const page = await executeExternalSessionCandidateQuery({
            activeServerDir: root, agentIdentity: { pluginId: 'fixture', localId: 'agent' },
            source: { kind: 'fixture' }, limit: 10,
            listCandidates: async () => ({ candidates: [
                { remoteSessionId: 'managed', updatedAtMs: 3, cwd: managed.directory },
                { remoteSessionId: 'managed-child', updatedAtMs: 2, cwd: join(managed.directory, 'child') },
                { remoteSessionId: 'other-stack', updatedAtMs: 2, cwd: join(root, 'other-stack', 'session-directories', managed.allocationId) },
                { remoteSessionId: 'windows', updatedAtMs: 2, cwd: `C:\\Users\\qa\\stack-state\\Session-Directories\\${managed.allocationId}\\child` },
                { remoteSessionId: 'ordinary', updatedAtMs: 1, cwd: join(root, 'session-directories-project') },
                { remoteSessionId: 'ordinary-name', updatedAtMs: 1, cwd: join(root, 'session-directories', 'my-project') },
                { remoteSessionId: 'allocation-sibling', updatedAtMs: 1, cwd: `${managed.directory}-project` },
                { remoteSessionId: 'unknown', updatedAtMs: 0 },
            ], nextCursor: 'native-continuation' }),
        });
        expect(page.candidates.map(candidate => candidate.remoteSessionId)).toEqual(['ordinary', 'ordinary-name', 'allocation-sibling', 'unknown']);
        expect(page.nextCursor).toBe('native-continuation');
    });
    it('publishes content hits without writing a metadata candidate index, including an empty query', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-content-query-'));
        roots.push(root);
        const match = { snippet: 'decoded body', sourceItemId: 'item-1', messageIndex: 2 };
        const page = await executeExternalSessionCandidateQuery({
            activeServerDir: root,
            agentIdentity: { pluginId: 'fixture', localId: 'fixture-agent' },
            source: { kind: 'fixture' },
            searchTarget: 'content',
            limit: 10,
            listCandidates: async (request) => {
                expect(request.searchTarget).toBe('content');
                return { candidates: [{ remoteSessionId: 'remote', updatedAtMs: 1, match }], nextCursor: null, contentCoverage: 'partial' };
            },
        });
        expect(page).toMatchObject({ candidates: [{ match }], contentCoverage: 'partial' });
        expect(await countCandidateIndexFiles(root)).toBe(0);
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(roots.splice(0).map(async (root) => {
            await rm(root, { recursive: true, force: true });
        }));
    });

    it('passes caller cancellation through indexed candidate identity hydration', async () => {
        const caller = new AbortController();
        caller.abort();
        const resolveLinkIdentity = vi.fn(async (request: Readonly<{
            signal?: AbortSignal;
        }>) => {
            if (request.signal?.aborted !== true) {
                throw new Error('resolveLinkIdentity did not receive caller cancellation');
            }
            throw new ExternalSessionProviderFailureError({
                code: 'cancelled',
                operation: 'resolveLinkIdentity',
                message: 'Candidate identity hydration was cancelled',
                retryable: false,
            });
        });

        await expect(hydrateExternalSessionCandidateThroughAgentSource({
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            candidate: {
                remoteSessionId: 'session-1',
                updatedAtMs: 1,
                linkData: { projectId: 'project-a' },
            },
            providerOps: {
                resolveLinkIdentity,
                listCandidates: vi.fn(),
            },
            signal: caller.signal,
        })).rejects.toMatchObject({
            name: 'ExternalSessionProviderFailureError',
            code: 'cancelled',
            operation: 'resolveLinkIdentity',
        });
        expect(resolveLinkIdentity).toHaveBeenCalledTimes(1);
    });

    it.each([
        {
            name: 'same-kind source rewrite',
            resolvedIdentity: {
                remoteSessionId: 'session-1',
                source: { kind: 'claudeConfig', configDir: '/rewritten/source' },
            },
        },
        {
            name: 'remote-session id rewrite',
            resolvedIdentity: {
                remoteSessionId: 'session-2',
                source: { kind: 'claudeConfig', configDir: '/private/source' },
            },
        },
    ])('rejects a $name before the second candidate lookup', async ({ resolvedIdentity }) => {
        const listCandidates = vi.fn();

        await expect(hydrateExternalSessionCandidateThroughAgentSource({
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            candidate: {
                remoteSessionId: 'session-1',
                updatedAtMs: 1,
                linkData: { projectId: 'project-a' },
            },
            providerOps: {
                resolveLinkIdentity: async () => resolvedIdentity,
                listCandidates,
            },
        })).rejects.toMatchObject({
            name: 'ExternalSessionProviderFailureError',
            code: 'source_invalid',
            operation: 'resolveLinkIdentity',
        });

        expect(listCandidates).not.toHaveBeenCalled();
    });

    it('allows candidate identity hydration to add source fields', async () => {
        const candidate = {
            remoteSessionId: 'session-1',
            updatedAtMs: 1,
            linkData: { projectId: 'project-a' },
        } as const;
        const listCandidates = vi.fn(async () => ({
            candidates: [candidate],
            nextCursor: null,
        }));

        await expect(hydrateExternalSessionCandidateThroughAgentSource({
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            candidate,
            providerOps: {
                resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
                    remoteSessionId,
                    source: { ...source, canonicalConfigFile: '/private/source/config.json' },
                }),
                listCandidates,
            },
        })).resolves.toEqual(candidate);

        expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({
            source: {
                kind: 'claudeConfig',
                configDir: '/private/source',
                canonicalConfigFile: '/private/source/config.json',
            },
            // An admitted row may be an internal thread; its exact lookup must still find it.
            includeThreads: true,
        }));
    });

    it('continues bounded candidate hydration when the exact match is beyond the first inspected entry', async () => {
        const caller = new AbortController();
        const candidate = {
            remoteSessionId: 'session-1',
            updatedAtMs: 1,
            linkData: { projectId: 'project-a' },
        } as const;
        const listCandidates = vi.fn(async ({ cursor }: Readonly<{ cursor?: string }>) => (
            cursor
                ? {
                    candidates: [candidate],
                    nextCursor: null,
                }
                : {
                    candidates: [],
                    nextCursor: 'scan:1',
                    searchIncomplete: true,
                }
        ));

        await expect(hydrateExternalSessionCandidateThroughAgentSource({
            source: { kind: 'ohMyPiAgentDir', agentDir: '/private/source' },
            candidate,
            providerOps: {
                resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
                    remoteSessionId,
                    source,
                }),
                listCandidates,
            },
            maxBytes: 4_096,
            signal: caller.signal,
        })).resolves.toEqual(candidate);

        expect(listCandidates).toHaveBeenCalledTimes(2);
        expect(listCandidates).toHaveBeenNthCalledWith(1, {
            source: { kind: 'ohMyPiAgentDir', agentDir: '/private/source' },
            limit: 1,
            searchTerm: 'session-1',
            searchMode: 'fast',
            includeThreads: true,
            maxBytes: 4_096,
            signal: caller.signal,
        });
        expect(listCandidates).toHaveBeenNthCalledWith(2, {
            source: { kind: 'ohMyPiAgentDir', agentDir: '/private/source' },
            cursor: 'scan:1',
            limit: 1,
            searchTerm: 'session-1',
            searchMode: 'fast',
            includeThreads: true,
            maxBytes: 4_096,
            signal: caller.signal,
        });
    });

    it('stops candidate hydration when a continuation cursor does not advance', async () => {
        const listCandidates = vi.fn(async () => ({
            candidates: [],
            nextCursor: 'scan:1',
            searchIncomplete: true,
        }));

        await expect(hydrateExternalSessionCandidateThroughAgentSource({
            source: { kind: 'ohMyPiAgentDir', agentDir: '/private/source' },
            candidate: {
                remoteSessionId: 'session-1',
                updatedAtMs: 1,
                linkData: { projectId: 'project-a' },
            },
            providerOps: {
                resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
                    remoteSessionId,
                    source,
                }),
                listCandidates,
            },
        })).rejects.toMatchObject({
            code: 'candidate_not_found',
            operation: 'listCandidates',
            retryable: true,
        });

        expect(listCandidates).toHaveBeenCalledTimes(2);
    });

    it('derives distinct opaque identities for duplicate native ids in different linkData scopes', () => {
        const projectA = resolveExternalSessionCandidateIdentityKey({
            remoteSessionId: 'shared-session',
            linkData: { projectId: 'project-a' },
        });
        const projectB = resolveExternalSessionCandidateIdentityKey({
            remoteSessionId: 'shared-session',
            linkData: { projectId: 'project-b' },
        });

        expect(projectA).toMatch(/^[a-f0-9]{64}$/);
        expect(projectB).toMatch(/^[a-f0-9]{64}$/);
        expect(projectA).not.toBe(projectB);
        expect(projectA).toBe(resolveExternalSessionCandidateIdentityKey({
            remoteSessionId: 'shared-session',
            linkData: { projectId: 'project-a' },
        }));
    });

});

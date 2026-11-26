import { execFile as execFileCallback } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { SessionMessageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';

import { ApiSessionClient } from '@/api/session/sessionClient';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createDeferred } from '@/testkit/async/deferred';
import { createHostScmCommandRunner } from '@/scm/runtime';
import { withTempDir } from '@/testkit/fs/tempDir';
import { readRepositoryCheckpointInitialEvidence } from '@/scm/checkpoints/sessionEvidence';
import { createRepositoryCheckpointPromptLifecycle } from './repositoryCheckpointPromptLifecycle';

// Only Home's HTTP and Socket.IO boundaries are substituted. The Session's
// mode-aware transcript reader and Git checkpoint producer run together.
vi.mock('socket.io-client', () => ({ io: () => createApiSessionSocketStub() }));
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});

const execFile = promisify(execFileCallback);

describe('initial checkpoint of an attached Session', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([true, false])('joins idle Git discovery before Session end releases the workspace (repository=%s)', async repository => {
        await withTempDir('happier-checkpoint-end-', async repoRoot => {
            if (repository) await execFile('git', ['init'], { cwd: repoRoot });
            const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
            const closed = createDeferred();
            let releaseClose: (() => void) | undefined;
            let exitCode: unknown;
            // Delay only the OS child's close notification; Git and all checkpoint
            // and Exec owners run normally beneath this external boundary.
            const boundary = vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
                const child = actual.spawn(command, args, options);
                const emit = child.emit.bind(child);
                const notifications = vi.spyOn(child, 'emit').mockImplementation((event, ...eventArgs) => {
                    if (event === 'close') {
                        exitCode = eventArgs[0];
                        releaseClose = () => {
                            releaseClose = undefined;
                            notifications.mockRestore();
                            emit(event, ...eventArgs);
                        };
                        closed.resolve();
                        return true;
                    }
                    return emit(event, ...eventArgs);
                });
                return child;
            });
            const lifecycle = createRepositoryCheckpointPromptLifecycle({
                session: createMutableApiSessionClientFixture({ sessionId: 'ending-session' }),
                runtimeDirectory: repoRoot, provider: 'codex',
                source: { protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                scmCommandRunner: createHostScmCommandRunner({ isCurrent: () => true,
                    agentIsolation: { read: () => ({ enabled: false, status: {
                        kind: 'effective', platform: 'linux', agentUser: 'happier-agent',
                    }, workspaceRoots: [] }) },
                }),
            });
            let ended: Promise<unknown> | undefined;
            try {
                await closed.promise;
                expect(exitCode).toBe(repository ? 0 : 128);
                let settled = false;
                ended = Promise.resolve(lifecycle.onSessionEnd?.()).then(() => { settled = true; });
                await Promise.resolve();
                await Promise.resolve();
                expect(settled).toBe(false);
                releaseClose?.();
                await ended;
                expect(settled).toBe(true);
            } finally {
                releaseClose?.();
                await ended;
                boundary.mockRestore();
            }
        });
    });

    it.each(['first', 'plugin-input-v1:SypCNfDzbNO_myZIqQ-M7kJK6VmcoEMhfSXzr-hGsRA', 'historical-first', null])('uses canonical earliest prompt evidence (%s)', async earliestLocalId => {
        await withTempDir('happier-attached-initial-', async repoRoot => {
            const git = async (...args: string[]) => (await execFile('git', args, { cwd: repoRoot })).stdout.trim();
            await git('init');
            await git('config', 'user.email', 'test@example.com');
            await git('config', 'user.name', 'Happier Test');
            await writeFile(join(repoRoot, 'tracked.txt'), 'committed\n');
            await git('add', 'tracked.txt');
            await git('commit', '-m', 'initial');
            await writeFile(join(repoRoot, 'tracked.txt'), 'before first dispatch\n');

            const sessionId = 'team-precreated-session';
            let transcriptReads = 0;
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                const target = new URL(String(url));
                if (target.pathname !== `/v1/sessions/${sessionId}/messages`) return { status: 404, data: {} };
                transcriptReads += 1;
                // Home's afterSeq ordering and role filter are honored: asking
                // for recent rows or an unfiltered inventory cannot prove first.
                const expectedQuery = target.searchParams.get('afterSeq') === '0'
                    && target.searchParams.get('role') === 'user'
                    && target.searchParams.get('scope') === 'main'
                    && target.searchParams.get('limit') === '1';
                if (!expectedQuery) throw new Error('Expected one earliest main user row');
                return { status: 200, data: {
                    messages: earliestLocalId === null ? [] : [SessionMessageV1Schema.parse({
                        id: 'earliest-user', seq: 2, createdAt: 1, localId: earliestLocalId,
                        messageRole: 'user', sidechainId: null,
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'edit' } } },
                    })], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
                } };
            });
            const socket = createApiSessionSocketStub();
            const session = new ApiSessionClient('fixture-token', createPlainSessionFixture({ id: sessionId }), {
                metadataAuthority: { kind: 'owner', credentials: { token: 'fixture-token', encryption: null } },
                getAccountEncryptionCurrentness: async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }),
                durableMutationDeliveryInitiallyActive: false,
                transport: { serverId: 'checkpoint-home', serverUrl: 'https://checkpoint-home.test',
                    createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
            });
            const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: repoRoot,
                provider: 'codex', source: { protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } }, sessionIsNew: false });
            try {
                const messageId = earliestLocalId?.startsWith('plugin-input-v1:') ? earliestLocalId : 'first';
                await lifecycle.onBeforePromptDispatch?.({ messageId, prompt: 'edit' });
                await lifecycle.onTurnStarted?.({ messageId, turnId: messageId });
                const initial = await readRepositoryCheckpointInitialEvidence({ cwd: repoRoot, scopeId: `${sessionId}:${repoRoot}` });
                if (earliestLocalId === messageId) {
                    expect(initial?.state).toBe('available');
                    if (initial?.state !== 'available') throw new Error('Missing proven initial checkpoint');
                    expect(await git('show', `${initial.commitSha}:tracked.txt`)).toBe('before first dispatch');
                } else {
                    expect(initial).toMatchObject({ state: 'unavailable', recoverable: true });
                }
                await writeFile(join(repoRoot, 'tracked.txt'), 'later agent edit\n');
                await lifecycle.onBeforePromptDispatch?.({ messageId: 'later', prompt: 'continue' });
                await lifecycle.onTurnStarted?.({ messageId: 'later', turnId: 'later' });
                expect(await readRepositoryCheckpointInitialEvidence({ cwd: repoRoot, scopeId: `${sessionId}:${repoRoot}` })).toEqual(initial);
                expect(transcriptReads).toBe(1);
            } finally {
                await lifecycle.onSessionEnd?.();
                await session.close();
            }
        });
    });
});

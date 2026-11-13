import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { writeTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol';

import { readRetainedPlainRunnerExitMarker, retireExactTerminalControlServiceability, retireStoppedPlainRunnerControlServiceability } from './retireTerminalControlServiceability';
import { recoverStrandedTerminalControlServiceability } from './recoverStrandedTerminalControlServiceability';
import { writeSessionMarker } from '../sessionRegistry';
import type { TrackedSession } from '../types';

describe('retireExactTerminalControlServiceability', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it.each(['exact', 'missing', 'other PID'] as const)('requires the executable birth for wrapped exit-marker recovery (%s)', async witness => {
        await withConfiguredDaemonTestHome({ prefix: 'wrapped-exit-marker-' }, async ({ homeDir }) => {
            const runnerPid = 999_123_456;
            const tracked: TrackedSession = { pid: runnerPid + 1, sessionRunnerPid: runnerPid,
                startedBy: 'daemon', happySessionId: 'wrapped-exit', processStartTimeMs: 100,
                ...(witness === 'missing' ? {} : { runnerProcessIdentity: {
                    pid: witness === 'exact' ? runnerPid : runnerPid + 2,
                    processStartTimeMs: witness === 'exact' ? 200 : 100, processCommandHash: 'a'.repeat(64),
                } }),
            };
            await writeSessionMarker({ pid: runnerPid, happySessionId: 'wrapped-exit',
                startedBy: 'daemon', processStartTimeMs: witness === 'exact' ? 200 : 100 });
            const marker = await readRetainedPlainRunnerExitMarker(tracked);
            if (witness === 'exact') expect(marker).toMatchObject({ pid: runnerPid, processStartTimeMs: 200 });
            else expect(marker).toBeNull();
        });
    });

    it('supplies one exact executable witness to the real stopped-runner publication', async () => {
        await withConfiguredDaemonTestHome({ prefix: 'wrapped-retirement-' }, async () => {
            const pid = 999_123_456;
            const sessionId = 'wrapped-retirement';
            const tracked: TrackedSession = { pid: pid + 1, sessionRunnerPid: pid, startedBy: 'daemon',
                happySessionId: sessionId, processStartTimeMs: 100,
                runnerProcessIdentity: { pid, processStartTimeMs: 200, processCommandHash: 'a'.repeat(64) } };
            vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
                data: String(url).includes('/v2/sessions/') ? { session: createSessionRecordFixture({ id: sessionId,
                    encryptionMode: 'plain', metadataLayoutVersion: 0, metadataVersion: 1,
                    metadata: JSON.stringify({ path: '/repo', hostPid: pid, hostProcessStartTimeMs: 200,
                        lifecycleState: 'running', terminal: { mode: 'plain' } }) }) }
                    : { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }));
            const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: {
                success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 0 },
            } });
            await expect(retireStoppedPlainRunnerControlServiceability({ sessionId, trackedSession: tracked,
                publishRetirement: (expectedRunner?: { pid: number; startTimeMs: number }) => {
                    if (!expectedRunner) throw new Error('Retirement owner omitted executable witness');
                    return retireExactTerminalControlServiceability({ credentials: { token: 'fixture', encryption: null },
                        sessionId, terminalMode: 'plain', expectedRunner, stoppedAt: 1234 });
                },
            })).resolves.toBe('retired');
            expect(SessionMetadataTuplePatchV1Schema.parse(patch.mock.calls[0]?.[1])).toMatchObject({
                target: { ownerMetadata: { t: 'plain', v: { runtime: { lifecycleState: 'stopped', lifecycleStateSince: 1234 } } } },
            });
        });
    });

    it.each(['replacement-runner', 'replacement-birth', 'active-attachment'] as const)(
        'does not infer an already-absent Stop target over %s', async state => {
        await withConfiguredDaemonTestHome({ prefix: 'stop-replacement-' }, async () => {
            const pid = 999_123_456;
            const metadata = { path: '/repo', ...(state === 'active-attachment'
                ? { terminal: { mode: 'tmux', controlServiceabilityV1: { v: 1, attachmentId: 'active-host',
                    state: 'servable', observedAt: 1 } } }
                : { hostPid: state === 'replacement-runner' ? pid + 1 : pid, hostProcessStartTimeMs: 201 }) };
            vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
                data: String(url).includes('/v2/sessions/') ? { session: createSessionRecordFixture({ id: 'replacement-stop',
                    encryptionMode: 'plain', metadataLayoutVersion: 0, metadataVersion: 1,
                    metadata: JSON.stringify(metadata) }) }
                    : { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }));
            const patch = vi.spyOn(axios, 'patch');
            await expect(retireExactTerminalControlServiceability({ credentials: { token: 'fixture', encryption: null },
                sessionId: 'replacement-stop', terminalMode: 'plain', expectedRunner: { pid, startTimeMs: 200 },
                stoppedAt: 1234 })).resolves.toBe('superseded');
            expect(patch).not.toHaveBeenCalled();
        });
    });

    it.each(['current', 'already-retired', 'replacement'] as const)(
        'publishes confirmed Stop only for the exact %s terminal attachment', async state => {
        vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
            data: String(url).includes('/v2/sessions/') ? {
                session: createSessionRecordFixture({ id: 'session-confirmed-stop', encryptionMode: 'plain',
                    metadataLayoutVersion: 0, metadataVersion: 1,
                    metadata: JSON.stringify({ path: '/repo', lifecycleState: 'running', terminal: { mode: 'tmux',
                        controlServiceabilityV1: { v: 1, attachmentId: state === 'replacement' ? 'new-attachment' : 'old-attachment',
                            state: 'unknown', observedAt: 1, ...(state === 'already-retired' ? { retired: true } : {}) } } }) }),
            } : { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }));
        const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: {
            success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 0 },
        } });
        const result = await retireExactTerminalControlServiceability({ credentials: { token: 'fixture', encryption: null },
            sessionId: 'session-confirmed-stop', terminalMode: 'tmux', attachmentId: 'old-attachment', stoppedAt: 1234 });
        if (state === 'replacement') {
            expect(result).toBe('superseded');
            expect(patch).not.toHaveBeenCalled();
        } else {
            expect(result).toBe('retired');
            const request = SessionMetadataTuplePatchV1Schema.parse(patch.mock.calls[0]?.[1]);
            expect(request).toMatchObject({ target: { ownerMetadata: { t: 'plain', v: { runtime: {
                lifecycleState: 'stopped', lifecycleStateSince: 1234,
            } } } } });
        }
    });

    it.each(['explicit-stop', 'observation', 'replacement'] as const)(
        'requires explicit Stop and the original dead runner for stranded publication: %s', async scenario => {
        await withConfiguredDaemonTestHome({ prefix: 'stranded-stop-' }, async () => {
            let sessionReads = 0;
            const pid = 999_123_456;
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                const sessionRead = String(url).includes('/v2/sessions/');
                if (sessionRead) sessionReads++;
                return { status: 200, data: sessionRead ? {
                    session: createSessionRecordFixture({ id: 'session-stranded-stop', encryptionMode: 'plain',
                        metadataLayoutVersion: 0, metadataVersion: 1,
                        metadata: JSON.stringify({ path: '/repo', machineId: 'machine-1', lifecycleState: 'running',
                            hostPid: scenario === 'replacement' && sessionReads > 1 ? pid + 1 : pid,
                            hostProcessStartTimeMs: 50, terminal: { mode: 'plain' } }) }),
                } : { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            });
            const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: {
                success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 0 },
            } });
            const credentials = { token: 'fixture', encryption: null };
            const result = await recoverStrandedTerminalControlServiceability({ credentials, currentMachineId: 'machine-1',
                sessionId: 'session-stranded-stop', ...(scenario === 'observation' ? {} : { stoppedAt: 1234 }),
                loadTerminalHostAdapters: async () => ({}),
                retireExactTerminalControlServiceability: target => retireExactTerminalControlServiceability({ credentials, ...target }),
            });
            if (scenario === 'explicit-stop') {
                expect(result).toEqual({ status: 'stopped' });
                expect(SessionMetadataTuplePatchV1Schema.parse(patch.mock.calls[0]?.[1])).toMatchObject({
                    target: { ownerMetadata: { t: 'plain', v: { runtime: { lifecycleState: 'stopped', lifecycleStateSince: 1234 } } } },
                });
            } else {
                expect(result).toEqual(scenario === 'observation' ? { status: 'stopped' }
                    : { status: 'incomplete', reason: 'attachment_mismatch' });
                expect(patch).not.toHaveBeenCalled();
            }
        });
    });

    it.each(['plain', 'tmux'] as const)('finishes %s control retirement when the Session has been deleted', async terminalMode => {
        vi.spyOn(axios, 'get').mockImplementation(async url => String(url).includes('/v2/sessions/')
            ? { status: 404, data: { error: 'Session not found' } }
            : { status: 200, data: { mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
        const patch = vi.spyOn(axios, 'patch').mockRejectedValue(new Error('Deleted Session must not be written'));
        const target = terminalMode === 'plain'
            ? { terminalMode, expectedRunner: { pid: 999_123_456, startTimeMs: 1 } }
            : { terminalMode, attachmentId: 'retired-attachment' };
        await expect(retireExactTerminalControlServiceability({
            credentials: { token: 'fixture', encryption: null }, sessionId: 'deleted-session', ...target,
        })).resolves.toBe('retired');
        expect(patch).not.toHaveBeenCalled();
    });

    it.each([403, 500])('retains retirement custody when the Session read fails with HTTP %s', async status => {
        vi.spyOn(axios, 'get').mockImplementation(async url => String(url).includes('/v2/sessions/')
            ? { status, data: { error: 'unavailable' } }
            : { status: 200, data: { mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
        await expect(retireExactTerminalControlServiceability({
            credentials: { token: 'fixture', encryption: null }, sessionId: 'unavailable-session',
            terminalMode: 'tmux', attachmentId: 'retained-attachment',
        })).rejects.toThrow();
    });

    it('refuses deleted Session retirement after requester admission is lost during the Home read', async () => {
        let current = true;
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (String(url).includes('/v2/sessions/')) return { status: 404, data: { error: 'Session not found' } };
            current = false;
            return { status: 200, data: { mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        });
        await expect(retireExactTerminalControlServiceability({
            credentials: { token: 'fixture', encryption: null }, sessionId: 'deleted-session',
            terminalMode: 'tmux', attachmentId: 'retained-attachment',
            currentness: { verifyCurrent: async () => current },
        })).rejects.toMatchObject({ code: 'session_publisher_authority_lost' });
    });

    it('overlaps requester admission and independent retirement reads without committing before admission', async () => {
        let releaseAuthority!: () => void;
        let authorityStarted!: () => void;
        const heldAuthority = new Promise<void>(resolve => { releaseAuthority = resolve; });
        const authorityReadStarted = new Promise<void>(resolve => { authorityStarted = resolve; });
        const reads = new Set<string>();
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/requester-currentness') {
                authorityStarted();
                await heldAuthority;
                return { status: 200, data: { current: true } };
            }
            reads.add(path);
            return { status: 200, data: path.includes('/v2/sessions/')
                ? { session: createSessionRecordFixture({ id: 'session-authority-overlap', encryptionMode: 'plain',
                    metadataLayoutVersion: 0, metadataVersion: 1,
                    metadata: JSON.stringify({ path: '/repo', terminal: { mode: 'tmux', controlServiceabilityV1: {
                        v: 1, attachmentId: 'attachment-overlap', state: 'servable', observedAt: 1,
                    } } }) }) }
                : { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        });
        const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: { success: true,
            metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 0 } } });
        const retirement = retireExactTerminalControlServiceability({ credentials: { token: 'fixture', encryption: null },
            sessionId: 'session-authority-overlap', attachmentId: 'attachment-overlap', terminalMode: 'tmux',
            // Model the remote authority read at HTTP, not the internal verifier.
            currentness: { verifyCurrent: async () => (await axios.get('http://authority.test/requester-currentness')).data.current === true },
        });
        try {
            await authorityReadStarted;
            await vi.waitFor(() => {
                expect(reads).toContain('/v2/sessions/session-authority-overlap');
                expect(reads).toContain('/v1/account/encryption/currentness');
            });
            expect(patch).not.toHaveBeenCalled();
        } finally {
            releaseAuthority();
            await retirement;
        }
        await expect(retirement).resolves.toBe('retired');
    });

    it('overlaps independent Home reads while awaiting the retirement commit', async () => {
        vi.useFakeTimers();
        try {
            const startedAt = Date.now();
            const completedAt: number[] = [];
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                const sessionRead = String(url).includes('/v2/sessions/');
                await new Promise(resolve => setTimeout(resolve, sessionRead ? 2000 : 1000));
                return { status: 200, data: sessionRead
                    ? { session: createSessionRecordFixture({ id: 'session-parallel-retirement', encryptionMode: 'plain',
                        metadataLayoutVersion: 0, metadataVersion: 1,
                        metadata: JSON.stringify({ path: '/repo', terminal: { mode: 'tmux', controlServiceabilityV1: {
                            v: 1, attachmentId: 'attachment-parallel', state: 'servable', observedAt: 1,
                        } } }) }) }
                    : { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            });
            vi.spyOn(axios, 'patch').mockImplementation(async () => {
                await new Promise(resolve => setTimeout(resolve, 500));
                return { status: 200, data: { success: true, metadataLayoutVersion: 1,
                    sharedMetadata: { version: 2 }, agentState: { version: 0 } } };
            });
            const retirement = retireExactTerminalControlServiceability({ credentials: { token: 'fixture', encryption: null },
                sessionId: 'session-parallel-retirement', attachmentId: 'attachment-parallel', terminalMode: 'tmux' })
                .then(result => { completedAt.push(Date.now() - startedAt); return result; });
            await vi.advanceTimersByTimeAsync(2499);
            expect(completedAt).toEqual([]);
            await vi.advanceTimersByTimeAsync(1001);
            await expect(retirement).resolves.toBe('retired');
            expect(completedAt).toEqual([2500]);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each((['live-runner', 'present-host', 'unreadable-host', 'replacement-runner'] as const)
        .flatMap(state => [true, false].map(hasProjection => ({ state, hasProjection }))))(
        'does not retire hosted metadata without dead-runner and absent-host authority: $state, projection=$hasProjection', async ({ state, hasProjection }) => {
        await withConfiguredDaemonTestHome({ prefix: 'retire-host-authority-' }, async ({ homeDir }) => {
            const pid = state === 'live-runner' ? process.pid : 999_123_456;
            const sessionId = 'session-retire-host';
            if (state === 'present-host' || state === 'unreadable-host') {
                await writeTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId, handle: {
                    kind: 'tmux', sessionName: 'retained-host', attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
                } });
                if (state === 'unreadable-host') await writeFile(join(homeDir, 'terminal', 'sessions', `${sessionId}.host.json`), '{');
            }
            vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: String(url).includes('/v2/sessions/')
                ? { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 0,
                    metadata: JSON.stringify({ path: homeDir, hostPid: state === 'replacement-runner' ? pid + 1 : pid,
                        hostProcessStartTimeMs: 1, terminal: { mode: 'tmux', ...(hasProjection ? { controlServiceabilityV1: {
                            v: 1, attachmentId: 'old-host', state: 'servable', observedAt: 1 } } : {}) } }) }) }
                : { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }));
            const patch = vi.spyOn(axios, 'patch').mockRejectedValue(new Error('Unexpected metadata retirement'));
            const retirement = retireExactTerminalControlServiceability({ credentials: { token: 'fixture', encryption: null },
                sessionId, terminalMode: 'plain', expectedRunner: { pid, startTimeMs: 1 }, stoppedAt: 1234 });
            if (state === 'replacement-runner') await expect(retirement).resolves.toBe('superseded');
            else await expect(retirement).rejects.toThrow('terminal_control_serviceability_retirement_runner_or_host_unresolved');
            expect(patch).not.toHaveBeenCalled();
        });
    });

    it('refuses a terminal metadata CAS when requester admission is lost during Account currentness read', async () => {
        let current = true;
        vi.spyOn(axios, 'get').mockImplementation(async (url) => {
            if (String(url).includes('/encryption/currentness')) {
                current = false;
                return { status: 200, data: { mode: 'plain', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            }
            return { status: 200, data: { session: createSessionRecordFixture({ id: 'session-bob',
                encryptionMode: 'plain', metadataLayoutVersion: 0, metadataVersion: 1,
                metadata: JSON.stringify({ path: '/repo', terminal: { mode: 'tmux', controlServiceabilityV1: {
                    v: 1, attachmentId: 'attachment-bob', state: 'servable', observedAt: 1,
                } } }), dataEncryptionKey: null }) } };
        });
        const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: {
            success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 0 },
        } });
        const input = { credentials: { token: 'bob', encryption: null }, sessionId: 'session-bob',
            attachmentId: 'attachment-bob', terminalMode: 'tmux' as const,
            currentness: { verifyCurrent: async () => current } };
        await expect(retireExactTerminalControlServiceability(input)).rejects.toMatchObject({ code: 'session_publisher_authority_lost' });
        expect(patch).not.toHaveBeenCalled();
    });

    it('retires a plain Session projection with token-only credentials', async () => {
        const get = vi.spyOn(axios, 'get')
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    session: createSessionRecordFixture({
                        id: 'session-plain-123',
                        encryptionMode: 'plain',
                        metadataLayoutVersion: 0,
                        metadata: JSON.stringify({
                            path: '/repo',
                            lifecycleState: 'running',
                            terminal: {
                                mode: 'tmux',
                                controlServiceabilityV1: {
                                    v: 1,
                                    attachmentId: 'attachment-1',
                                    state: 'servable',
                                    observedAt: 1,
                                },
                            },
                        }),
                        metadataVersion: 4,
                        agentState: null,
                        agentStateVersion: 0,
                        dataEncryptionKey: null,
                    }),
                },
            } as never)
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    mode: 'plain',
                    version: 1,
                    signingKeyFingerprint: null,
                    contentKeyFingerprint: null,
                    updatedAt: 1,
                },
            } as never);
        const patch = vi.spyOn(axios, 'patch').mockResolvedValueOnce({
            status: 200,
            data: {
                success: true,
                metadataLayoutVersion: 1,
                sharedMetadata: { version: 5 },
                agentState: { version: 0 },
            },
        } as never);

        await expect(retireExactTerminalControlServiceability({
            credentials: {
                token: 'token-only',
                encryption: null,
            },
            sessionId: 'session-plain-123',
            attachmentId: 'attachment-1',
            terminalMode: 'tmux',
        })).resolves.toBe('retired');

        expect(get).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-plain-123'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-only',
                }),
            }),
        );
        expect(patch).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-plain-123'),
            expect.objectContaining({
                mode: 'owner_migration',
                target: expect.objectContaining({
                    ownerMetadata: expect.objectContaining({ t: 'plain' }),
                }),
            }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-only',
                }),
            }),
        );
        const request = patch.mock.calls[0]?.[1] as {
            target?: { ownerMetadata?: { t?: unknown; v?: unknown } };
        };
        expect(request.target?.ownerMetadata).toMatchObject({
            t: 'plain',
            v: {
                runtime: {
                    lifecycleState: 'running',
                    terminal: {
                        mode: 'tmux',
                        controlServiceabilityV1: {
                            v: 1,
                            attachmentId: 'attachment-1',
                            state: 'unknown',
                            reason: 'attachment_retired',
                            retired: true,
                        },
                    },
                },
            },
        });
    });
});

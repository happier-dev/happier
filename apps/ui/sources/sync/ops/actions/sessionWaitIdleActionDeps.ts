import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1 } from '@happier-dev/protocol/sessions/messages/sessionTranscriptPageLimits';
import {
    readSessionTranscriptTurnActivity, resolveSessionIdleWaitDurationMs, waitForIdleObservation, waitForSessionIdle, type IdleSocketObserver,
} from '@happier-dev/session-core/transcript';
import { fetchSessionMessagesPage, openSessionStoredContent, type SessionStoredContentContext } from '@happier-dev/sync-client';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { createScopedSocketConnectParams } from '@/sync/runtime/orchestration/serverScopedRpc/createScopedSocketConnectParams';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

type WaitPort = NonNullable<ActionExecutorDeps['sessionWaitIdle']>;

export function createUiSessionWaitIdleActionDep(account: LazyActionAccountContext | undefined): WaitPort {
    return async ({ sessionId, timeoutSeconds, serverId, signal: callerSignal }) => {
        if (!account) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        if (serverId && !areServerProfileIdentifiersEquivalent(serverId, account.serverId)) {
            return { ok: false, code: 'session_not_found' };
        }
        return await withActionAccountRequestSignal(account, callerSignal ?? account.invocationSignal, signal =>
            runWithServerRequestAuthorityForServerAccountScope({
                scope: account.accountLifetime.scope, activeRequest: account.request,
            }, authority => waitForSessionIdle({
                timeoutMs: resolveSessionIdleWaitDurationMs(timeoutSeconds),
                signal,
                readTarget: async ({ signal, remainingTimeoutMs }) => {
                    const readSnapshot = async () => (await readSessionSnapshotForAuthority({
                        authority, sessionId, signal, isCurrent: account.accountLifetime.isCurrent,
                        includeTurns: false, includeMetadataTupleMutationSnapshot: false,
                    })).session;
                    const session = await readSnapshot().catch((error: unknown) => {
                        if (error instanceof SessionSnapshotReadError && error.httpStatus === 404) return null;
                        throw error;
                    });
                    if (!session) return { ok: false, code: 'session_not_found' };
                    if (session.encryptionMode !== 'plain' && session.encryptionMode !== 'e2ee') {
                        return { ok: false, code: 'unsupported' };
                    }
                    const encryption = authority.context.encryption?.getSessionEncryption(sessionId) ?? null;
                    const content: SessionStoredContentContext = session.encryptionMode === 'plain'
                        ? { mode: 'plain' }
                        : { mode: 'e2ee', encryption };
                    if (content.mode === 'e2ee' && !encryption) return { ok: false, code: 'encryption_material_unavailable' };

                    const observe: IdleSocketObserver = handlers => {
                        let dispose = () => {};
                        let disposed = false;
                        const ready = createEphemeralServerSocketClient({
                            ...createScopedSocketConnectParams(authority.context, authority.transferCarrierCustody),
                            sessionId, signal, timeoutMs: remainingTimeoutMs(),
                        }).then(socket => {
                            if (disposed) { socket.disconnect(); return; }
                            // Keep delivery order while the platform opens encrypted payloads.
                            let delivered = Promise.resolve();
                            const onUpdate = (value: unknown) => {
                                delivered = delivered.then(() => handlers.onUpdate(value)).catch(handlers.onError);
                            };
                            const onConnected = () => { void delivered.then(handlers.onConnected); };
                            socket.on('update', onUpdate);
                            socket.on('connect', onConnected);
                            dispose = () => {
                                socket.off('update', onUpdate);
                                socket.off('connect', onConnected);
                                socket.disconnect();
                            };
                            onConnected();
                        }).catch(handlers.onError);
                        return { dispose: async () => { disposed = true; dispose(); await ready; } };
                    };

                    return {
                        ok: true, sessionId: session.id, projection: session,
                        readTurnActivity: () => readSessionTranscriptTurnActivity({
                            assertReadActive: () => signal.throwIfAborted(),
                            maxPageSize: SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1,
                            readPage: async pagination => {
                                const page = await fetchSessionMessagesPage({
                                    sessionId, scope: 'main', projection: 'activity', ...pagination, signal,
                                    requestJson: async (path, signal) => {
                                        const response = await authority.request(path, { signal });
                                        if (!response.ok) throw new Error('Session activity unavailable');
                                        return await response.json();
                                    },
                                });
                                if (page.hasMore === undefined) throw new Error('Session activity unavailable');
                                return page;
                            },
                            openRow: async row => {
                                const opened = await openSessionStoredContent(content, row.content);
                                if (opened.status !== 'ready') throw new Error('Session activity content unavailable');
                                return opened.value;
                            },
                        }),
                        waitForObservation: options => waitForIdleObservation({
                            ...options, initialAgentState: session.agentState,
                            observe,
                            readSnapshot: async () => {
                                const projection = await readSnapshot();
                                return { projection, agentState: projection.agentState };
                            },
                            openAgentState: async (value, version) => {
                                if (content.mode === 'plain') {
                                    try { return JSON.parse(value); } catch { return null; }
                                }
                                const opened = await encryption?.decryptAgentStateResult(version, value);
                                return opened?.status === 'available' ? opened.value : null;
                            },
                            openMessage: async value => {
                                const opened = await openSessionStoredContent(content, value);
                                return opened.status === 'ready' ? opened.value : null;
                            },
                        }),
                    };
                },
            })));
    };
}

import { io } from 'socket.io-client';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SessionPermissionMediationRecordStoredSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import type { SessionPermissionMediationRecordStored } from '@happier-dev/protocol';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { RpcRequest } from '@/api/rpc/types';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { registerCurrentSessionUiBinding } from '@/session/presentation/currentSessionUiBindings';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from './createCliActionDeps';
import { encodeSessionSystemRecordRevision } from '../../../../server/sources/app/session/systemRecords/sessionSystemRecordRevision';
import type { AgentState } from '@/api/types';
import { accountSettingsParse } from '@happier-dev/protocol';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const [url, sessionId, accountId] = process.argv.slice(2);
if (!url || !sessionId || !accountId || !process.send) throw new Error('Missing child fixture arguments or IPC');
// Use the same authoritative empty Account/role catalog as the provider
// permission owner tests. An unavailable role catalog correctly denies writes.
setActiveAccountSettingsSnapshot({ scopeKey: 'permission-process', source: 'network', settingsVersion: 1,
    settings: accountSettingsParse({}), rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
    promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
const records = new Map<string, SessionPermissionMediationRecordStored>();
let revision = 0;
const key = (identity: Readonly<{ turnId: string; requestId: string }>) => JSON.stringify([identity.turnId, identity.requestId]);
let agentState: AgentState = { requests: {}, completedRequests: {} };
const published = Promise.withResolvers<void>();
const updateAgentState = (update: (previous: AgentState) => AgentState) => {
    agentState = update(agentState);
    if (Object.keys(agentState.requests ?? {}).length === 3) published.resolve();
};
// This is the Session persistence boundary. The permission owner, mediation
// store codec, request coordinator, Action executor and socket transport are real.
const session = createMutableApiSessionClientFixture({ sessionId, metadata: {}, agentState: { requests: {}, completedRequests: {} }, overrides: {
    getAgentStateSnapshot: () => agentState,
    updateAgentState,
    updateAgentStateRequestSettlement: async update => { updateAgentState(update); },
    getStoredContentEncryptionContext: () => ({ mode: 'plain', ctx: null }),
    getAuthenticatedAccountId: async () => accountId,
    readPermissionMediationRecord: async ({ identity }) => records.get(key(identity)) ?? null,
    writePermissionMediationRecord: async ({ identity, request }) => {
        const previous = records.get(key(identity));
        if ((previous?.revision ?? null) !== request.expectedRevision) {
            throw Object.assign(new Error('conflict'), { code: 'permission_mediation_record_conflict' });
        }
        const stored = SessionPermissionMediationRecordStoredSchema.parse({ ...identity, kind: request.kind,
            content: request.content, revision: encodeSessionSystemRecordRevision({ id: key(identity), version: ++revision }) });
        records.set(key(identity), stored);
        return stored;
    },
    listPermissionMediationRecords: async () => ({ records: [...records.values()], nextCursor: null, hasNext: false }),
    prunePermissionMediationRecord: async ({ identity }) => { records.delete(key(identity)); },
} });
// Exercise ApiSessionClient's production registration owner, not a test-only
// installation of the very permission route whose absence this journey must catch.
const registration = registerSessionHandlers(session.rpcHandlerManager, process.cwd(), { sessionId,
    transcriptActionExecutor: createActionExecutor(createCliActionDeps({ token: accountId, sessionId, mode: 'plain', ctx: null })) });
const handler = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[permission process fixture]' });
const lifetime = new AbortController();
const dispose = registerCurrentSessionUiBinding({ sessionId, service: {} as never,
    signal: lifetime.signal, isCurrent: () => true,
    capabilities: { permissionHandler: handler, readPermissionMode: () => 'default' } });
const socket = io(url, { path: '/v1/updates/', autoConnect: false, reconnection: false, query: { publisher: '1' } });
socket.on(SOCKET_RPC_EVENTS.REQUEST, (request: RpcRequest, acknowledge: (result: unknown) => void) => {
    void session.rpcHandlerManager.handleRequest(request).then(acknowledge);
});
await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
});
session.rpcHandlerManager.onSocketConnect(socket);
const ready = await session.rpcHandlerManager.waitForRegisteredHandlers(['session.permission.respond'], { timeoutMs: 10_000 });
if (ready.status !== 'ready') throw new Error(`Session publisher registration failed: ${JSON.stringify(ready)}`);
let closing = false;
async function close() {
    if (closing) return;
    closing = true;
    lifetime.abort();
    dispose();
    await handler.abortPendingRequestsAndFlush('process fixture cleanup');
    session.rpcHandlerManager.onSocketDisconnect();
    socket.disconnect();
    await registration.dispose();
    await session.close();
    process.disconnect?.();
}
process.on('message', message => { if (message === 'close') void close(); });
process.on('disconnect', () => { void close(); });
const sourceAuthority = { kind: 'mediatedExternal', mediatorPluginId: 'happier.channels', sourceRef: 'channels:binding:binding-1',
    sourceRevisionOrEpoch: '1:1', admittedPermissionCeiling: 'default', remoteApprovalMaxScope: 'request' } as const;
for (const requestId of ['allow-request', 'deny-request', 'question-request']) {
    const question = requestId === 'question-request';
    const pending = handler.handleToolCall(requestId, question ? 'AskUserQuestion' : 'Edit',
        question ? { questions: [{ question: 'Which branch?', options: [{ label: 'main' }, { label: 'release' }] }] }
            : { file_path: '/fixture/alpha.txt', old_string: 'before', new_string: 'after' },
        { turnId: `turn-${requestId}`, causalPermissionAuthority: {
            kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default', sourceAuthority,
        } });
    void pending.then(result => {
        // Before readiness, an automatic decision falsifies this live-pending
        // fixture instead of leaving publication to hang silently.
        published.reject(new Error(`Session fixture unexpectedly settled ${requestId} before readiness`));
        process.send?.({ kind: 'settled', requestId, result,
            completed: session.getAgentStateSnapshot()?.completedRequests?.[requestId], records: [...records.values()] });
    }, error => {
            if (!lifetime.signal.aborted) published.reject(error);
        });
}
// Observe the actual persistence boundary rather than polling a private Map.
await published.promise;
process.send({ kind: 'ready', pid: process.pid, projection: handler.listMediatedPendingRequests({
    mediatorPluginId: 'happier.channels', sourceRef: 'channels:binding:binding-1', sourceRevisionOrEpoch: '1:1',
}) });

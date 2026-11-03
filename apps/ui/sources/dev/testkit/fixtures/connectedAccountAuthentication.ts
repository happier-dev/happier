import type { ConnectedAccountAttemptTransactionRecord } from '@happier-dev/cli-common/connectedAccounts';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS } from '@happier-dev/cli-common/connectedAccounts';

/** Stateful HTTP/database boundary for the actual addressed transaction API. */
export async function answerAttemptTransaction(request: URL, init: RequestInit | undefined,
    transactions: Map<string, ConnectedAccountAttemptTransactionRecord>): Promise<Response | null> {
    const prefix = '/v2/connect/connected-account-attempt-transactions/';
    if (!request.pathname.startsWith(prefix)) return null;
    const method = init?.method ?? 'GET';
    const address = request.pathname.slice(prefix.length).split('/');
    if (method === 'GET' && address[0] === 'pending' && address.length === 1) {
        const machineId = request.searchParams.get('machineId');
        return Response.json({ attempts: [...transactions].flatMap(([attemptId, record]) => {
            const scope = record.scope;
            if (scope.phase === 'starting' || record.expiresAtMs <= Date.now()
                || scope.service.pluginId !== request.searchParams.get('pluginId')
                || scope.service.localId !== request.searchParams.get('localId')
                || scope.machineId !== (machineId ?? undefined)) return [];
            return [{ attemptId, kind: record.kind, modeId: scope.modeId, intent: scope.intent,
                phase: scope.phase, createdAtMs: scope.createdAtMs, expiresAtMs: record.expiresAtMs }];
        }) });
    }
    if (method === 'GET') {
        const current = address.length === 1 ? transactions.get(decodeURIComponent(address[0]!)) : undefined;
        return current ? Response.json(current)
            : Response.json({ error: 'connected_account_attempt_transaction_not_found' }, { status: 404 });
    }
    const [kind, encodedAttemptId] = address;
    if (address.length !== 2 || (kind !== 'manual' && kind !== 'oauth' && kind !== 'device') || !encodedAttemptId) {
        throw new Error('Fixture only accepts the transaction kinds supported by the actual API');
    }
    const key = decodeURIComponent(encodedAttemptId);
    const current = transactions.get(key);
    if (method === 'DELETE') { transactions.delete(key); return Response.json({ status: 'deleted' }); }
    const body = await new Response(init?.body).json() as Omit<ConnectedAccountAttemptTransactionRecord, 'kind' | 'revision' | 'expiresAtMs'>
        & { expiresAtMs?: number; expectedRevision?: number };
    if ((method === 'POST' && current) || (method === 'PATCH' && body.expectedRevision !== current?.revision)) {
        return Response.json({ error: 'connected_account_attempt_transaction_conflict' }, { status: 409 });
    }
    // Match the server POST's existing finite lifetime default. PATCH always
    // carries the finite deadline returned by that producer.
    const expiresAtMs = body.expiresAtMs ?? (method === 'POST' ? Date.now() + CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS : undefined);
    if (expiresAtMs === undefined) return Response.json({ error: 'connected_account_attempt_transaction_expiry_invalid' }, { status: 400 });
    const next: ConnectedAccountAttemptTransactionRecord = { kind, revision: (current?.revision ?? 0) + 1, content: body.content, expiresAtMs, scope: body.scope };
    transactions.set(key, next);
    return Response.json(next);
}

/** A fake native RPC host persists its real finite address through the shared owner. */
export async function createNativeAttemptAddressBoundary(account: LazyActionAccountContext, machineId: string) {
    const [{ createConnectedAccountAttemptTransactionAdapters, generatePkceCodes },
        { createUiConnectedAccountAttemptTransactionApi }, { createUiConnectedAccountContent },
        { getRandomBytes }, { digest }] = await Promise.all([
        import('@happier-dev/cli-common/connectedAccounts'),
        import('@/sync/ops/connectedAccounts/connectedAccountAttemptTransactions'),
        import('@/sync/ops/connectedAccounts/connectedAccountContent'),
        import('@/platform/cryptoRandom'),
        import('@/platform/digest'),
    ]);
    const content = createUiConnectedAccountContent(account);
    return createConnectedAccountAttemptTransactionAdapters({
        api: createUiConnectedAccountAttemptTransactionApi(account),
        getMachineId: () => machineId,
        randomBytes: getRandomBytes,
        generatePkceCodes: () => generatePkceCodes({ randomBytes: getRandomBytes,
            sha256: bytes => digest('SHA-256', bytes) }),
        seal: async payload => content.seal('attempt', await content.resolveAccountMode('fresh-authority'), payload),
        open: async record => {
            const opened = content.open('attempt', await content.resolveAccountMode(), record.content);
            if (opened === null) throw new Error('Native fixture attempt cannot be opened');
            return opened;
        },
    }).address;
}

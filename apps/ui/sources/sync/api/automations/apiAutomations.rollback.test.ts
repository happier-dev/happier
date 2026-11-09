import { expect, it } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { reconcileAutomationDefinition } from './apiAutomations';

const credentials: AuthCredentials = { token: 'test-token', secret: 'test-secret' };

it.each([
    { status: 503, body: { error: 'database_transaction_conflict_exhausted', statusCode: 503 }, code: 'database_transaction_conflict_exhausted' },
    { status: 503, body: { error: 'database_transaction_conflict_exhausted' }, code: 'workflow_outcome_unresolved' },
    { status: 500, body: { error: 'database_transaction_conflict_exhausted', statusCode: 503 }, code: 'workflow_outcome_unresolved' },
])('preserves only the confirmed rollback contract ($status / $code)', async ({ status, body, code }) => {
    // Inject only the HTTP boundary; keep the native transport and receipt owner real.
    const request = async () => new Response(JSON.stringify(body), { status });
    await expect(reconcileAutomationDefinition(credentials, 'set-one', {
        expectedTemplateVersion: 8, name: 'Team schedule', description: null, enabled: true,
        assignments: [], triggers: [], removedTriggers: [],
    }, { serverId: 'test', request })).rejects.toMatchObject({ code });
});

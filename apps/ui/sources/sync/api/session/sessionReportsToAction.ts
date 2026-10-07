import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SessionReportsToSetRequestV1Schema, SessionReportsToSetResultV1Schema } from '@happier-dev/protocol/sessions/relations/sessionReportsToV1';
import { projectSessionFollowSourceKeyPreparationAfterSetV1, type SessionFollowSourceKeyPreparationResultV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { prepareSessionFollowSourceKey } from '@/components/sessions/follow/prepareSessionFollowSourceKey';

/** The captured Action Account owns credentials, cancellation and Home currentness. */
export function createSessionReportsToAction(
    account: Pick<LazyActionAccountContext, 'serverId' | 'request' | 'assertCurrent'> | null,
): NonNullable<ActionExecutorDeps['sessionReportsToSet']> {
    return async ({ sessionId, leadSessionId, expectedLeadSessionId, serverId, context, signal }) => {
        if (!account) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        const requestedHome = serverId ?? context.serverId;
        if (requestedHome && !areServerProfileIdentifiersEquivalent(requestedHome, account.serverId)) {
            return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        }
        account.assertCurrent();
        const body = SessionReportsToSetRequestV1Schema.parse({ leadSessionId, expectedLeadSessionId });
        const transport = getActionSpec('session.reports_to.set').serverTransport;
        if (!transport) throw new TypeError('Missing reportsTo Action transport');
        const response = await account.request(transport.path.replace(':sessionId', encodeURIComponent(sessionId)), {
            method: transport.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            ...((signal ?? context.signal) ? { signal: signal ?? context.signal } : {}),
        }, { includeAuth: true });
        const payload: unknown = await response.json();
        account.assertCurrent();
        const parsed = SessionReportsToSetResultV1Schema.safeParse(payload);
        if (parsed.success) {
            const result = parsed.data;
            const expectedStatus = result.ok ? 200 : result.error === 'reports_to_cycle' ? 400
                : result.error === 'reports_to_cas_conflict' ? 409 : 403;
            if (response.status === expectedStatus && (!result.ok
                || (result.sessionId === sessionId && result.leadSessionId === leadSessionId))) {
                if (!result.ok || leadSessionId === null) return result;
                let preparation: SessionFollowSourceKeyPreparationResultV1;
                try {
                    preparation = await prepareSessionFollowSourceKey({
                        serverId: account.serverId, sourceSessionId: sessionId, destinationSessionId: leadSessionId,
                    });
                } catch {
                    preparation = { kind: 'waiting', reason: 'runner_unreachable' };
                }
                account.assertCurrent();
                const projected = projectSessionFollowSourceKeyPreparationAfterSetV1({ source: result }, preparation);
                return 'ok' in projected ? projected : result;
            }
        }
        const errorCode = response.status === 401 ? 'not_authenticated'
            : response.status === 404 ? 'unsupported_action' : 'invalid_action_output';
        return { ok: false, errorCode, error: errorCode };
    };
}

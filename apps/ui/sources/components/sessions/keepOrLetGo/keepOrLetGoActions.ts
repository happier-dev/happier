import { resolveSessionOrganizationMutationScope } from '@/sync/domains/session/organization/mutationScope';
import { setSessionPin } from '@/sync/ops/sessionOrganization/setSessionPin';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

import type { KeepStackKeepResult } from './KeepStack';

const PIN_LIMIT_CODE = 'session-pin-limit-exceeded';

/**
 * Keep = pin, through the one pin owner (optimistic write, rollback on refusal). At the limit the
 * owner's own message names the limit; the card returns with it, plus a way to Plus only where the
 * server shows plans.
 */
export async function keepLeavingSession(input: Readonly<{
    serverId: string;
    sessionId: string;
    plansAction: Readonly<{ label: string; onPress: () => void }> | null;
}>): Promise<KeepStackKeepResult> {
    const resolved = await resolveSessionOrganizationMutationScope(input.serverId);
    if (!resolved.ok) return { ok: false, message: t('errors.unknownError') };
    try {
        await setSessionPin({ ...resolved.scope, sessionId: input.sessionId, pinned: true });
        return { ok: true };
    } catch (error) {
        const message = error instanceof Error && error.message ? error.message : t('errors.unknownError');
        if (error instanceof HappyError && error.code === PIN_LIMIT_CODE) {
            return input.plansAction ? { ok: false, message, action: input.plansAction } : { ok: false, message };
        }
        return { ok: false, message };
    }
}

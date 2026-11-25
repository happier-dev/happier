import { t } from '@/text';
import { VERCEL_RESOURCE_STOPPED_CODE } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';

/**
 * The typed use-time refusal of a managed acquisition in one sentence, or `null` for a code it does not know.
 * A preset's availability card and a failed creation's step read the same words; the machine list says the
 * controller one too.
 */
export function describeManagedAcquisitionRefusal(code: string): string | null {
    switch (code) {
        case 'permission_denied': return t('session.startFailure.cause.permission_denied');
        case 'controller_unavailable': return t('managedMachines.controller.requiredUnnamed');
        case 'credential_unavailable': return t('session.startFailure.cause.credential_unavailable');
        case 'provider_unavailable': return t('session.startFailure.cause.provider_unavailable');
        case 'controller_retired': return t('session.startFailure.cause.controller_retired');
        case 'request_conflict': return t('session.startFailure.cause.request_conflict');
        case 'intent_changed': return t('session.startFailure.cause.intent_changed');
        case 'managed_not_found': return t('session.startFailure.cause.managed_not_found');
        case 'enrollment_retired': return t('session.startFailure.cause.enrollment_retired');
        case VERCEL_RESOURCE_STOPPED_CODE: return resolveSystemTaskFailureMessage({ code }) ?? null;
        default: return null;
    }
}

import { Modal } from '@/modal';
import { t } from '@/text';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

/** Deliberate disclosure of a typed Action failure, never its private transport details. */
export function alertActionFailure(failure: Readonly<{
    reason: string;
    code: string | null;
    context?: Readonly<{ phase: string; targetHome: string | null }>;
    recovery?: Readonly<{ label: string; onPress: () => void }>;
}>): void {
    if (!failure.code) {
        Modal.alert(t('common.error'), failure.reason);
        return;
    }
    const details = failure.context
        ? JSON.stringify({ code: failure.code, ...failure.context }, null, 2)
        : failure.code;
    const uncertain = failure.code === RPC_ERROR_CODES.OUTCOME_UNKNOWN;
    Modal.alert(
        t(uncertain ? 'toolView.pending.unknownTitle' : 'common.error'),
        uncertain ? t('toolView.pending.unknownDescription') : failure.reason,
        [
            ...(failure.recovery ? [{ text: failure.recovery.label, onPress: failure.recovery.onPress }] : []),
            { text: t('approvals.technicalDetails'), onPress: () => Modal.alert(t('approvals.technicalDetails'), details) },
            { text: t('common.ok'), style: 'cancel' },
        ],
    );
}

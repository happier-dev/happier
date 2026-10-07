import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
    LocalDateTimeEditor,
    resolveFutureLocalDateTime,
} from '@/components/ui/dateTime/LocalDateTimeEditor';
import {
    toLocalDateTimeDraft,
    type LocalDateTimeDraft,
} from '@/components/ui/dateTime/localDateTimeValue';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';

/** A day ahead is a useful place to start editing from; it is never a default answer. */
const INITIAL_EXPIRY_OFFSET_MS = 24 * 60 * 60 * 1000;

/**
 * The author's own date and time for when an unclaimed Runner package stops
 * working.
 *
 * The offered shortcuts resolve to an instant, and so does this: the package
 * expiry is one absolute moment chosen once, never a duration something has to
 * keep counting. A reading in the past is refused here rather than being sent to
 * a Home that would only reject it later.
 */
export function TemporaryComputerExpiryModal(props: Readonly<{
    nowMs: number;
    currentExpiresAt?: number;
    onResolve: (expiresAt: number | null) => void;
}> & CustomModalInjectedProps) {
    const [draft, setDraft] = React.useState<LocalDateTimeDraft>(() => toLocalDateTimeDraft(new Date(
        props.currentExpiresAt !== undefined && props.currentExpiresAt > props.nowMs
            ? props.currentExpiresAt
            : props.nowMs + INITIAL_EXPIRY_OFFSET_MS,
    )));
    const expiresAt = resolveFutureLocalDateTime(draft, props.nowMs);

    const finish = React.useCallback((value: number | null) => {
        props.onResolve(value);
        props.onClose();
    }, [props]);

    const footer = React.useMemo(() => (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
            <RoundButton display="inverted" title={t('common.cancel')} onPress={() => finish(null)} />
            <RoundButton
                testID="temporary-computer-expiry-confirm"
                title={t('common.done')}
                disabled={expiresAt === null}
                onPress={() => { if (expiresAt !== null) finish(expiresAt); }}
            />
        </View>
    ), [expiresAt, finish]);

    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: t('newSession.temporaryComputer.expiry.title'),
        testID: 'temporary-computer-expiry-modal',
        dimensions: { width: 480, maxHeightRatio: 0.86, size: 'md' as const },
        footer,
    }), [footer]));

    return (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 18, gap: 16 }}>
            <LocalDateTimeEditor
                nowMs={props.nowMs}
                value={draft}
                onChange={setDraft}
                testIDPrefix="temporary-computer-expiry"
                labels={{
                    date: t('newSession.temporaryComputer.expiry.dateLabel'),
                    time: t('newSession.temporaryComputer.expiry.timeLabel'),
                    pastInstant: t('newSession.temporaryComputer.expiry.pastInstant'),
                }}
            />
        </ScrollView>
    );
}

/** Resolves to the chosen absolute instant, or `null` when the author backed out. */
export async function showTemporaryComputerExpiryModal(input: Readonly<{
    nowMs: number;
    currentExpiresAt?: number;
}>): Promise<number | null> {
    return await new Promise((resolve) => {
        Modal.show({
            component: TemporaryComputerExpiryModal,
            props: {
                nowMs: input.nowMs,
                ...(input.currentExpiresAt !== undefined ? { currentExpiresAt: input.currentExpiresAt } : {}),
                onResolve: resolve,
            },
            onRequestClose: () => resolve(null),
            chrome: {
                kind: 'card',
                title: t('newSession.temporaryComputer.expiry.title'),
                testID: 'temporary-computer-expiry-modal',
                dimensions: { width: 480, maxHeightRatio: 0.86, size: 'md' },
            },
            closeOnBackdrop: true,
        });
    });
}

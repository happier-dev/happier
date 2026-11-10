import * as React from 'react';
import { View } from 'react-native';

import { executeSessionLifecycleAction } from '@/components/sessions/actions/sessionActionExecution';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

const LINK_SLOT_STYLE = { minHeight: Typography.variant('meta').lineHeight, justifyContent: 'center' } as const;

/**
 * Brings an archived Session this one led back to Inactive: the row's one operation, written as words
 * beside it. It runs the same `session.unarchive` Action every Session menu runs, under that Action's
 * own approval setting; the row moves to the live list when the Home confirms.
 */
export const WorkRowUnarchive = React.memo(function WorkRowUnarchive(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    title: string;
}>) {
    const { sessionId, serverId } = props;
    const [pending, setPending] = React.useState(false);
    const unarchive = React.useCallback(() => {
        setPending(true);
        fireAndForget((async () => {
            try {
                const result = await executeSessionLifecycleAction('session.unarchive', sessionId, { serverId });
                if (!result.success) Modal.alert(t('common.error'), result.message ?? t('sessionInfo.failedToUnarchiveSession'));
            } finally {
                setPending(false);
            }
        })(), { tag: 'SessionWork.unarchiveReport' });
    }, [serverId, sessionId]);
    return (
        // The link's touch frame takes no layout, so the row would centre a zero-height box: give it its line.
        <View style={LINK_SLOT_STYLE}>
        <TextLinkButton
            testID={`session-work-unarchive:${sessionId}`}
            label={t('sessionWork.actions.unarchive')}
            accessibilityLabel={`${t('sessionWork.actions.unarchive')}, ${props.title}`}
            size="meta"
            disabled={pending}
            onPress={unarchive}
        />
        </View>
    );
});

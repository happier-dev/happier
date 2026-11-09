import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { InboxWorkRow } from '../InboxWorkRow';
import {
    SessionListIdentity,
    type SessionListIdentityDisplay,
} from '@/components/sessions/shell/SessionListIdentity';
import { SESSION_LIST_ROW_IDENTITY_METRICS } from '@/components/sessions/shell/resolveSessionListDensityViewState';
import type { Session } from '@/sync/domains/state/storageTypes';

export const InboxSessionAttentionHeader = React.memo(function InboxSessionAttentionHeader(props: Readonly<{
    session: Session;
    serverId: string | null;
    identityDisplay: SessionListIdentityDisplay;
    connected: boolean;
    sessionTitle: string;
    machineLabel: string | null;
    pathLabel: string | null;
    onOpenSession: () => void;
    /** The item open beside the list: its row is drawn selected. */
    selected?: boolean;
    /** The row's own state, age and menu, so a row that carries requests reads like its sheet-mates. */
    row?: Pick<React.ComponentProps<typeof InboxWorkRow>, 'status' | 'time' | 'narrow' | 'trailingAccessory'>;
}>) {
    const { theme } = useUnistyles();

    return (
        <InboxWorkRow testID={`inbox.session_attention.${props.serverId ?? 'local'}.${props.session.id}`}
            title={props.sessionTitle} facts={[props.machineLabel, props.pathLabel]}
            accessibilityLabel={t('inbox.openSession', { session: props.sessionTitle })}
            selected={props.selected}
            onPress={props.onOpenSession}
            {...props.row}
            mark={props.identityDisplay !== 'none' ? (
                <SessionListIdentity
                    session={props.session}
                    display={props.identityDisplay}
                    serverId={props.serverId}
                    color={theme.colors.text.primary}
                    avatarSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize}
                    agentLogoSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.agentLogoSize}
                    connected={props.connected}
                    testID={`inbox.session_attention.${props.serverId ?? 'local'}.${props.session.id}.identity`}
                />
            ) : null}
        />
    );
});

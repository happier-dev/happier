import * as React from 'react';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { InboxWorkGroup } from '@/activity/presentation/buildInboxWorkGroups';
import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { InboxSection } from '@/components/inbox/InboxSection';
import {
    SessionListIdentity,
    type SessionListIdentityDisplay,
} from '@/components/sessions/shell/SessionListIdentity';
import {
    formatWorkflowRunDisplayName,
    resolveWorkflowRunDisplayName,
} from '@/components/workflows/presentation/workflowRunDisplayName';
import { Icon } from '@/components/ui/icons/Icon';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Text } from '@/components/ui/text/Text';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { isFocusedInboxWorkItem, type InboxItemFocus } from '../inboxItemFocus';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import { readInboxSessionTitle } from '@/components/inbox/sessionAttention/inboxSessionPrivacy';
import { Typography } from '@/constants/Typography';

import { InboxWorkItemRow } from './InboxWorkItemRow';

const MARK_SIZE = 18;

type GroupHeader = Readonly<{
    title: string;
    leading: React.ReactNode;
    meta: string | null;
    open: Readonly<{ label: string; route: string }> | null;
}>;

function useGroupHeader(group: InboxWorkGroup, identityDisplay: SessionListIdentityDisplay): GroupHeader {
    const { theme } = useUnistyles();
    const root = group.root;
    switch (root.kind) {
        case 'lead': {
            const session = root.session;
            const serverId = session?.serverId ?? null;
            const reports = session?.reports?.total ?? 0;
            return {
                title: session ? readInboxSessionTitle(session, serverId) : t('inbox.work.groups.unknownLead'),
                leading: session && identityDisplay !== 'none' ? (
                    <SessionListIdentity
                        session={session}
                        display={identityDisplay}
                        serverId={serverId}
                        color={theme.colors.text.primary}
                        avatarSize={MARK_SIZE}
                        agentLogoSize={MARK_SIZE - 4}
                        connected
                        testID={`inbox.group.${group.key}.identity`}
                    />
                ) : <Icon name="tree-structure" size={MARK_SIZE} color={theme.colors.text.secondary} />,
                meta: reports > 0 ? t('inbox.work.groups.leadMeta', { count: reports }) : null,
                open: { label: t('inbox.work.groups.openSession'), route: createActivitySurfaceSessionRoute(root.sessionId, serverId) },
            };
        }
        case 'run':
            return {
                title: formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(root.row.metadata)),
                leading: <Icon name="tree-structure" size={MARK_SIZE} color={theme.colors.text.secondary} />,
                meta: t('inbox.work.groups.runMeta'),
                open: { label: t('inbox.work.groups.openRun'), route: createWorkflowRunRoute(root.runId) },
            };
        case 'other':
            return {
                title: t('inbox.work.groups.otherTitle'),
                leading: <Icon name="chat-circle" size={MARK_SIZE} color={theme.colors.text.secondary} />,
                meta: t('inbox.work.groups.otherMeta'),
                open: null,
            };
    }
}

/**
 * One work root and everything under it that needs the person (lab `inbox-I1`): the root's mark,
 * name and one quiet fact, "Open session"/"Open run", then its rows. `extra` carries rows that
 * belong only to "Other sessions" (approvals, operations).
 */
export const InboxWorkGroupSection = React.memo(function InboxWorkGroupSection(props: Readonly<{
    group: InboxWorkGroup;
    model: InboxModel;
    identityDisplay: SessionListIdentityDisplay;
    nowMs: number;
    presentation: 'screen' | 'popover';
    spacingBefore?: 'following' | 'separated';
    navigate: (route: string) => void;
    onBeforeNavigate?: () => void;
    /** The item the person came to see, drawn selected. */
    focusedItem?: InboxItemFocus | null;
    extra?: React.ReactNode;
}>) {
    const header = useGroupHeader(props.group, props.identityDisplay);
    const page = props.presentation === 'screen';
    return (
        <InboxSection
            testID={`inbox.group.${props.group.key}`}
            title={header.title}
            surface={page ? 'page' : 'flat'}
            spacingBefore={props.spacingBefore}
            leading={header.leading}
            meta={header.meta ? <Text style={styles.meta}>{header.meta}</Text> : undefined}
            rightAccessory={page && header.open ? (
                <SectionActionButton
                    testID={`inbox.group.${props.group.key}.open`}
                    title={header.open.label}
                    icon="arrow-square-out"
                    onPress={() => props.navigate(header.open!.route)}
                />
            ) : undefined}
        >
            {props.group.items.map((item) => (
                <InboxWorkItemRow
                    key={item.key}
                    item={item}
                    model={props.model}
                    identityDisplay={props.identityDisplay}
                    nowMs={props.nowMs}
                    presentation={props.presentation}
                    navigate={props.navigate}
                    onBeforeNavigate={props.onBeforeNavigate}
                    focused={isFocusedInboxWorkItem(item, props.focusedItem ?? null, props.model.workflowAttention.serverId)}
                />
            ))}
            {props.extra}
        </InboxSection>
    );
});

const styles = StyleSheet.create((theme) => ({
    meta: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('sectionDescription'),
        color: theme.colors.text.secondary,
    },
}));

import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionScmPullRequestDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { Icon } from '@/components/ui/icons/Icon';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSetting } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import { GitPullRequestCard } from './GitPullRequestCard';
import { GitPullRequestForm, type GitPullRequestCreated } from './GitPullRequestForm';
import { resolveGitPullRequestCardModel } from './gitPullRequestCardModel';
import {
    closeGitPullRequestForm,
    moveGitPullRequestForm,
    resolveGitPullRequestFormPlacement,
    useGitPullRequestFormState,
} from './gitPullRequestFormState';

/**
 * The Git sidebar's pull request slot (Git lab PR): the new pull request form when it was asked for and lives in
 * the sidebar; a one-line pointer while it lives in Details; otherwise the branch's pull request card when it has
 * one. It renders nothing when there is nothing to show.
 */
export const GitPullRequestSection = React.memo(function GitPullRequestSection(props: Readonly<{
    sessionId: string;
    serverId?: string;
    scopeId: string;
    snapshot: ScmWorkingSnapshot;
    machineReachable: boolean;
}>) {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const form = useGitPullRequestFormState(props.sessionId, props.serverId);
    const placementSetting = useSetting('scmPullRequestPlacement');
    const phone = useSurfaceStateSize() === 'phone';
    const [justCreated, setJustCreated] = React.useState<GitPullRequestCreated | null>(null);

    const openDetailsTab = pane.openDetailsTab;
    const openInDetails = React.useCallback(() => {
        openDetailsTab(createSessionScmPullRequestDetailsTab(), { intent: 'pinned' });
        moveGitPullRequestForm(props.sessionId, props.serverId, 'details');
    }, [openDetailsTab, props.serverId, props.sessionId]);

    // A new request (the header's Create PR) is placed here, where the pane is known.
    React.useEffect(() => {
        if (!form.open || form.placement !== null) return;
        const placement = resolveGitPullRequestFormPlacement({ setting: placementSetting, phone });
        if (placement === 'details') openInDetails();
        else moveGitPullRequestForm(props.sessionId, props.serverId, 'sidebar');
        setJustCreated(null);
    }, [form.open, form.placement, openInDetails, phone, placementSetting, props.serverId, props.sessionId]);

    const onClose = React.useCallback(() => closeGitPullRequestForm(props.sessionId, props.serverId), [props.serverId, props.sessionId]);
    const onCreated = React.useCallback((created: GitPullRequestCreated) => {
        setJustCreated(created);
        closeGitPullRequestForm(props.sessionId, props.serverId);
    }, [props.serverId, props.sessionId]);

    const card = resolveGitPullRequestCardModel(props.snapshot, justCreated);

    if (form.open && form.placement === 'sidebar') {
        return (
            <GitPullRequestForm
                sessionId={props.sessionId}
                serverId={props.serverId}
                snapshot={props.snapshot}
                machineReachable={props.machineReachable}
                placement="sidebar"
                onExpand={openInDetails}
                onClose={onClose}
                onCreated={onCreated}
            />
        );
    }
    if (form.open && form.placement === 'details') {
        return (
            <View testID="git-pull-request-pointer" style={styles.pointer}>
                <Icon name="git-pull-request" size={14} color={theme.colors.text.secondary} />
                <Text numberOfLines={1} style={styles.pointerText}>{t('sessionGitPullRequest.form.pointer')}</Text>
                <Pressable
                    testID="git-pull-request-pointer-show"
                    accessibilityRole="button"
                    onPress={() => openDetailsTab(createSessionScmPullRequestDetailsTab(), { intent: 'pinned' })}
                    hitSlop={8}
                >
                    <Text style={styles.pointerAction}>{t('sessionGitPullRequest.form.pointerShow')}</Text>
                </Pressable>
            </View>
        );
    }
    if (card) {
        return <GitPullRequestCard model={card.model} animateIn={card.source === 'just-created'} />;
    }
    return null;
});

const styles = StyleSheet.create((theme) => ({
    pointer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 4,
    },
    pointerText: { flex: 1, minWidth: 0, fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() },
    pointerAction: { fontSize: 12, color: theme.colors.text.link, ...Typography.default('semiBold') },
}));

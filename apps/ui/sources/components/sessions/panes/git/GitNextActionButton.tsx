import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { t } from '@/text';

import type { SessionGitPaneAction, SessionGitPaneActionKey, SessionGitPaneHeaderAction } from './sessionGitPaneHeader';

export type GitNextActionMenuExtra = Readonly<{ id: string; title: string; subtitle?: string; icon: IconName; disabled?: boolean; onPress: () => void }>;

/**
 * The header's next-best action and its menu (Git lab A/S): the one sync step the branch needs now, as a
 * split button whose chevron lists every sync operation with its state (never silently missing). While the
 * step runs the button is its progress ("Pushing 3…"); its width is held so the header does not jump.
 */
export const GitNextActionButton = React.memo(function GitNextActionButton(props: Readonly<{
    primary: SessionGitPaneHeaderAction;
    menu: readonly SessionGitPaneAction[];
    /** The step that is running now (from the operation owner), if it is one of these. */
    runningKey: SessionGitPaneActionKey | null;
    upstream: string | null;
    baseBranch: string | null;
    onRun: (key: SessionGitPaneActionKey) => void;
    extras?: readonly GitNextActionMenuExtra[];
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [open, setOpen] = React.useState(false);
    const { primary } = props;
    const running = props.runningKey !== null && props.runningKey === primary.key;
    const attention = primary.key === 'resolve' || primary.emphasis === 'attention';
    const tone = primary.emphasis === 'primary' && !running && !attention ? 'primary' : 'default';
    const contentColor = attention ? theme.colors.state.warning.foreground : tone === 'primary'
        ? theme.colors.button.primary.tint
        : primary.emphasis === 'quiet' ? theme.colors.text.secondary : theme.colors.text.primary;
    const onPrimary = React.useCallback(() => props.onRun(primary.key), [primary.key, props.onRun]);

    const items = React.useMemo<DropdownMenuItem[]>(() => {
        const iconColor = theme.colors.text.secondary;
        const list: DropdownMenuItem[] = props.menu.map((action) => ({
            id: action.key,
            testID: `session-git-action-menu:${action.key}`,
            title: menuTitle(action),
            subtitle: menuSubtitle(action, props.upstream, props.baseBranch),
            icon: <Icon name={actionIcon(action.key)} size={14} color={iconColor} />,
            disabled: action.disabled,
        }));
        for (const extra of props.extras ?? []) {
            list.push({
                id: `extra:${extra.id}`,
                testID: `session-git-action-menu:${extra.id}`,
                title: extra.title,
                ...(extra.subtitle ? { subtitle: extra.subtitle } : {}),
                icon: <Icon name={extra.icon} size={14} color={iconColor} />,
                category: t('sessionGitPane.flow.menu.more'),
                disabled: extra.disabled,
            });
        }
        return list;
    }, [props.baseBranch, props.extras, props.menu, props.upstream, theme.colors.text.secondary]);

    const onSelect = React.useCallback((id: string) => {
        setOpen(false);
        if (id.startsWith('extra:')) {
            const extra = props.extras?.find((extra) => `extra:${extra.id}` === id);
            if (extra && !extra.disabled) extra.onPress();
            return;
        }
        props.onRun(id as SessionGitPaneActionKey);
    }, [props.extras, props.onRun]);

    return (
        <View style={styles.split}>
            <ToolbarButton
                testID={`session-git-header-action:${primary.key}`}
                label={running ? runningLabel(primary) : primaryLabel(primary)}
                tone={tone}
                disabled={primary.disabled || running || primary.key === 'up-to-date'}
                busy={running}
                labelColor={contentColor}
                icon={running ? <ActivitySpinner size={14} color={contentColor} /> : <Icon name={actionIcon(primary.key)} size={14} color={contentColor} />}
                onPress={onPrimary}
                style={[styles.primaryPart, attention ? { backgroundColor: theme.colors.state.warning.background, borderColor: theme.colors.state.warning.border } : null, running || primary.emphasis === 'quiet' ? { borderWidth: 0, backgroundColor: 'transparent', opacity: 1 } : null]}
            />
            <DropdownMenu
                open={open}
                onOpenChange={setOpen}
                items={items}
                onSelect={onSelect}
                search={false}
                matchTriggerWidth={false}
                maxWidthCap={280}
                placement="bottom"
                popoverAnchorAlign="end"
                trigger={({ toggle }) => (
                    <ToolbarButton
                        testID="session-git-header-action-menu"
                        label=""
                        accessibilityLabel={t('sessionGitPane.flow.menu.open')}
                        tone={tone}
                        icon={<Icon name="caret-down" size={12} color={contentColor} />}
                        onPress={toggle}
                        style={[styles.chevronPart, attention ? { backgroundColor: theme.colors.state.warning.background, borderColor: theme.colors.state.warning.border } : null, running || primary.emphasis === 'quiet' ? { borderWidth: 0, backgroundColor: 'transparent' } : null]}
                    />
                )}
            />
        </View>
    );
});

function actionIcon(key: SessionGitPaneActionKey): IconName {
    switch (key) {
        case 'push': return 'arrow-up';
        case 'pull': return 'arrow-down';
        case 'fetch': return 'arrows-clockwise';
        case 'publish': return 'cloud';
        case 'create-pr': return 'git-pull-request';
        case 'open-pr': return 'git-pull-request';
        case 'resolve': return 'warning';
        case 'up-to-date': return 'check';
    }
}

function count(value: number | null): string {
    return value === null ? '' : formatExactCount(value);
}

function primaryLabel(action: SessionGitPaneAction): string {
    switch (action.key) {
        case 'push': return t('sessionGitPane.header.push', { count: count(action.count) });
        case 'pull': return t('sessionGitPane.header.pull', { count: count(action.count) });
        case 'fetch': return t('sessionGitPane.flow.action.fetch');
        case 'publish': return t('sessionGitPane.flow.action.publish');
        case 'create-pr': return t('sessionGitPane.flow.action.createPr');
        case 'open-pr': return t('sessionGitPane.flow.action.openPr', { number: String(action.count ?? '') });
        case 'resolve': return t('sessionGitPane.flow.action.resolve', { count: count(action.count) });
        case 'up-to-date': return t('sessionGitPane.flow.action.upToDate');
    }
}

function runningLabel(action: SessionGitPaneAction): string {
    switch (action.key) {
        case 'push': return t('sessionGitPane.flow.action.pushing', { count: count(action.count) });
        case 'pull': return t('sessionGitPane.flow.action.pulling', { count: count(action.count) });
        case 'fetch': return t('sessionGitPane.flow.action.fetching');
        case 'publish': return t('sessionGitPane.flow.action.publishing');
        case 'create-pr': return t('sessionGitPane.flow.action.creatingPr');
        default: return primaryLabel(action);
    }
}

function menuTitle(action: SessionGitPaneAction): string {
    switch (action.key) {
        case 'push': return action.count ? t('sessionGitPane.header.push', { count: count(action.count) }) : t('sessionGitPane.flow.menu.push');
        case 'pull': return action.count ? t('sessionGitPane.header.pull', { count: count(action.count) }) : t('sessionGitPane.flow.menu.pull');
        case 'create-pr': return t('sessionGitPane.flow.menu.createPr');
        default: return primaryLabel(action);
    }
}

function menuSubtitle(action: SessionGitPaneAction, upstream: string | null, baseBranch: string | null): string | undefined {
    if (action.reason === 'unavailable') return t('sessionGitPane.flow.menu.unavailable');
    const target = upstream ?? t('sessionGitPane.flow.failed.origin');
    switch (action.key) {
        case 'push': return action.count ? t('sessionGitPane.flow.menu.pushTo', { target }) : t('sessionGitPane.flow.menu.nothingToPush');
        case 'pull': return action.count ? t('sessionGitPane.flow.menu.pullFrom', { target }) : t('sessionGitPane.flow.menu.upToDate');
        case 'fetch': return t('sessionGitPane.flow.menu.fetchHint');
        case 'publish': return t('sessionGitPane.flow.menu.publishHint');
        case 'create-pr': return baseBranch ? t('sessionGitPane.flow.menu.createPrInto', { base: baseBranch }) : undefined;
        default: return undefined;
    }
}

const stylesheet = StyleSheet.create(() => ({
    split: {
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    primaryPart: {
        borderTopRightRadius: 0,
        borderBottomRightRadius: 0,
    },
    chevronPart: {
        borderTopLeftRadius: 0,
        borderBottomLeftRadius: 0,
        marginLeft: StyleSheet.hairlineWidth,
        paddingHorizontal: 6,
    },
}));

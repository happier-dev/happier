import React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { ScmComparisonMenuSection } from '@/components/sessions/files/comparison/ScmComparisonMoreMenu';

export type ReviewCommentsHeaderButtonProps = Readonly<{
    labels: Readonly<{
        title: string;
        count: (params: Readonly<{ count: number }>) => string;
    }>;
    /** Unresolved comments once they have been read; null while unknown, so nothing claims "0". */
    unresolvedCount: number | null;
    expanded: boolean;
    onPress?: () => void;
    /** `compact`: the same disclosure as a bar action (glyph, title, count) for a host's comparison bar. */
    compact?: boolean;
    testID?: string;
}>;

/** The review comments disclosure: one quiet row in the pane's own row anatomy. */
export function ReviewCommentsHeaderButton(props: ReviewCommentsHeaderButtonProps) {
    const { theme } = useUnistyles();
    const count = props.unresolvedCount;
    if (props.compact) {
        const title = count != null && count > 0 ? `${props.labels.title} · ${count}` : props.labels.title;
        return <RoundButton testID={props.testID} size="small" display="inverted" title={title}
            onPress={props.onPress}
            leading={<Icon name="chat-circle" size={ICON_SIZE.xs} color={theme.colors.text.primary} />} />;
    }
    return (
        <Item
            testID={props.testID}
            density="compact"
            title={props.labels.title}
            detail={count != null && count > 0 ? props.labels.count({ count }) : undefined}
            icon={<Icon name="chat-circle" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
            accessibilityExpanded={props.expanded}
            onPress={props.onPress}
        />
    );
}

/** The same disclosure as a row of a phone header's menu (where a bar has no room for the compact button). */
export function useReviewCommentsMenuSection(props: Readonly<{
    enabled: boolean;
    labels: ReviewCommentsHeaderButtonProps['labels'];
    unresolvedCount: number | null;
    expanded: boolean;
    onToggle: () => void;
    testID?: string;
}>): ScmComparisonMenuSection | null {
    const { theme } = useUnistyles();
    const { enabled, labels, unresolvedCount, expanded, onToggle, testID } = props;
    return React.useMemo(() => enabled ? {
        id: 'review-comments',
        items: [{ id: 'toggle', testID, category: '', checked: expanded,
            title: unresolvedCount != null && unresolvedCount > 0 ? `${labels.title} · ${unresolvedCount}` : labels.title,
            icon: <Icon name="chat-circle" size={ICON_SIZE.sm} color={theme.colors.text.secondary} /> }],
        onSelect: onToggle,
    } : null, [enabled, expanded, labels, onToggle, testID, theme.colors.text.secondary, unresolvedCount]);
}

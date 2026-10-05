import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Header, DefaultBackButton } from '@/components/navigation/Header';
import { HeaderTitleWithAction } from '@/components/navigation/HeaderTitleWithAction';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolveSessionScmReviewViewLabel, type SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { t } from '@/text';
import { ScmComparisonScopePicker, type ScmComparisonScopePickerProps } from './ScmComparisonScopePicker';

/** Phone comparison navigation: the standard header, with the same scope and actions as the wide bar. */
export function ScmComparisonPhoneHeader(props: Readonly<{
    view: SessionScmReviewView;
    views: readonly SessionScmReviewView[];
    scope: ScmComparisonScopePickerProps;
    onSelectView: (view: SessionScmReviewView) => void;
    onBack: () => void;
    onStartReview: () => void;
    reviewDisabled?: boolean;
    reviewDisabledReason?: string | null;
    onProposeCommits?: (() => void) | null;
    /** View-owned actions retain their own availability and lifecycle inside the trailing menu. */
    extraActions?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const items: DropdownMenuItem[] = props.views.map((view) => ({ id: `view:${view}`,
        title: resolveSessionScmReviewViewLabel(view), checked: props.view === view }));
    items.push({ id: 'start-review', testID: 'scm-comparison-start-review', title: t('scmComparison.startReview'),
        disabled: props.reviewDisabled, subtitle: props.reviewDisabledReason ?? undefined });
    if (props.onProposeCommits) items.push({ id: 'propose-commits', title: t('scmComparison.proposeCommits') });
    const subtitle = [props.scope.currentLabel, props.scope.fileCount === null ? null
        : t('scmComparison.fileCount', { count: props.scope.fileCount })].filter(Boolean).join(' · ');
    return <Header safeAreaEnabled={false} headerShadowVisible={false}
        headerLeft={() => <DefaultBackButton testID="scm-comparison-phone-back" tintColor={theme.colors.text.primary} onPress={props.onBack} />}
        title={<ScmComparisonScopePicker {...props.scope} renderTrigger={({ toggle, open: scopeOpen }) => <HeaderTitleWithAction
            title={resolveSessionScmReviewViewLabel(props.view)} subtitle={subtitle} actionLabel={t('scmComparison.scopePicker.a11y')}
            actionIconName={scopeOpen ? 'caret-up' : 'caret-down'} onActionPress={toggle} />} />}
        headerRight={() => <DropdownMenu testID="scm-comparison-phone-actions" open={open} onOpenChange={setOpen}
            items={items} search={false} matchTriggerWidth={false} placement="bottom" popoverAnchorAlign="end"
            footer={props.extraActions ? <View style={styles.extraActions}>{props.extraActions}</View> : undefined}
            onSelect={(id) => {
                const view = props.views.find((candidate) => id === `view:${candidate}`);
                if (view) props.onSelectView(view);
                else if (id === 'start-review' && !props.reviewDisabled) props.onStartReview();
                else if (id === 'propose-commits') props.onProposeCommits?.();
            }}
            trigger={({ toggle }) => <IconButton testID="scm-comparison-phone-more" iconName="dots-three" variant="plain"
                accessibilityLabel={t('common.more')} onPress={toggle} />} />} />;
}

const styles = StyleSheet.create(() => ({ extraActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 12 } }));

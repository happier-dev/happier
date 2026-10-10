import * as React from 'react';
import { HappierWorkRowShell, HappierWorkSummary, HappierWorkStatusWord, joinHappierFacts, type HappierWorkRowShellProps, type HappierWorkSummaryProps } from '@happier-dev/plugin-ui/presentation';
import { WORK_HOST, useWorkTheme } from '@/components/work/map/WorkMapView';

/** Inbox binds the Work anatomy; request classification and answer controls remain with their owners. */
export const InboxWorkRow = React.memo(function InboxWorkRow(props: Readonly<{
    testID: string; title: string; facts?: readonly React.ReactNode[]; mark?: React.ReactNode;
    phase?: HappierWorkSummaryProps['phase']; status?: HappierWorkSummaryProps['trailingState']; time?: React.ReactNode;
    inlineStatus?: boolean;
    accessibilityLabel?: string; selected?: boolean; onPress: () => void; trailingAccessory?: React.ReactNode;
    accessibilityLiveRegion?: 'none' | 'polite' | 'assertive';
    accessibilityActions?: HappierWorkRowShellProps['accessibilityActions'];
    onAccessibilityAction?: HappierWorkRowShellProps['onAccessibilityAction'];
}>) {
    const theme = useWorkTheme();
    const label = props.accessibilityLabel ?? joinHappierFacts(props.title, props.status?.word,
        ...(props.facts ?? []).filter((fact): fact is string => typeof fact === 'string'));
    const facts = props.inlineStatus && props.status ? [<HappierWorkStatusWord key="state" role="rowLine" tone={props.status.tone}
        theme={theme} host={WORK_HOST}>{props.status.word}</HappierWorkStatusWord>, ...(props.facts ?? [])] : props.facts ?? [];
    return <HappierWorkRowShell testID={props.testID} accessibilityLabel={label} selected={props.selected}
        onPress={props.onPress} trailingAccessory={props.trailingAccessory} accessibilityActions={props.accessibilityActions}
        onAccessibilityAction={props.onAccessibilityAction} theme={theme}>
        <HappierWorkSummary testID={`${props.testID}.summary`} title={props.title} phase={props.phase ?? 'attention'}
            mark={props.mark} facts={facts} trailingState={props.inlineStatus ? null : props.status} trailingTime={props.time}
            accessibilityLabel={label} accessibilityLiveRegion={props.accessibilityLiveRegion} theme={theme} host={WORK_HOST} />
    </HappierWorkRowShell>;
});

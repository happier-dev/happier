import * as React from 'react';

import type { CustomModalInjectedProps } from '@/modal';
import type { SelectionListOption } from '@/components/ui/selectionList';
import { t } from '@/text';
import type { BugReportSessionTarget } from '@/components/settings/bugReports/bugReportDiagnostics';
import { resolveBugReportAccountIdForServer } from '@/components/settings/bugReports/bugReportSessionTarget';

import { SessionSelectionModal } from './SessionSelectionModal';

export type ReportSessionSelection = (BugReportSessionTarget & Readonly<{ accountId: string | null }>) | null | undefined;

export type ReportSessionSelectionModalProps = CustomModalInjectedProps & Readonly<{
    allowNoSession?: boolean;
    onResolve: (selection: ReportSessionSelection) => void;
}>;

export function ReportSessionSelectionModal(props: ReportSessionSelectionModalProps) {
    const leadingOptions = React.useMemo<ReadonlyArray<SelectionListOption>>(() => props.allowNoSession === false ? [] : [{
        id: 'no-related-session',
        label: t('bugReports.noRelatedSession'),
    }], [props.allowNoSession]);

    return <SessionSelectionModal
        {...props}
        testID="report-session-selection"
        title={t('bugReports.sessionPickerTitle')}
        subtitle={t('bugReports.sessionPickerSubtitle')}
        searchPlaceholder={t('bugReports.sessionPickerSearchPlaceholder')}
        emptyStateLabel={t('bugReports.sessionPickerNoResults')}
        leadingOptions={leadingOptions}
        onSelectSession={async (selection) => {
            const accountId = await resolveBugReportAccountIdForServer(selection.serverId);
            props.onResolve({ ...selection, accountId });
        }}
        onSelectOption={(id) => props.onResolve(id === 'no-related-session' ? null : undefined)}
        onDismiss={() => props.onResolve(undefined)}
    />;
}

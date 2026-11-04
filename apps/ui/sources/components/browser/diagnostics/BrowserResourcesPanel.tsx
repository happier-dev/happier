import * as React from 'react';

import { selectBrowserDiagnosticResourceRows, type BrowserDiagnosticResourceRow } from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

import {
    BrowserDiagnosticsFamilyPanelFrame,
    DiagnosticsColumnHeader,
    DiagnosticsRow,
    type BrowserDiagnosticsFamilyPanelProps,
    fieldLabel,
    formatDurationMs,
} from './BrowserDiagnosticsFamilyPanel';

type ResourceRow = BrowserDiagnosticResourceRow;

function displayName(name: string | undefined): string {
    if (!name) return '—';
    const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(name);
    return match ? (match[1] ?? '/') : name;
}

/** The page's resource timings as one table: path, type and time, from the latest snapshot. */
export function BrowserResourcesPanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    const events = props.events;
    const rows = React.useMemo(() => selectBrowserDiagnosticResourceRows({ events }), [events]);
    const selectItems = React.useCallback(
        (_segment: string, query: string) => selectBrowserDiagnosticResourceRows({ events }, { search: query }),
        [events],
    );
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="resources"
            items={rows}
            countLabel={(count) => t('browserDiagnostics.host.devtools.count.resources', { count })}
            searchPlaceholder={t('browserDiagnostics.host.devtools.search.resources')}
            selectItems={selectItems}
            renderItems={(visible) => (
                <>
                    <DiagnosticsColumnHeader
                        testID={`${props.testID}-resources-columns`}
                        subject={t('browserDiagnostics.host.devtools.resources.name')}
                        meta={[fieldLabel('resourceType') ?? '', fieldLabel('durationMs') ?? '']}
                    />
                    {visible.map((row: ResourceRow, index) => (
                        <DiagnosticsRow
                            key={row.key}
                            testID={`${props.testID}-resources-entry-${index}`}
                            subject={displayName(row.entry.name)}
                            meta={[
                                row.entry.initiatorType ? { text: row.entry.initiatorType } : null,
                                typeof row.entry.durationMs === 'number' ? { text: formatDurationMs(row.entry.durationMs) } : null,
                            ]}
                        />
                    ))}
                </>
            )}
        />
    );
}

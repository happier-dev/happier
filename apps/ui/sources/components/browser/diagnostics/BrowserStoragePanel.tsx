import * as React from 'react';
import { Text } from '@/components/ui/text/Text';

import { selectBrowserDiagnosticStorageRows, type BrowserDiagnosticStorageRow } from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

import {
    browserDiagnosticsPanelStyles as styles,
    BrowserDiagnosticsFamilyPanelFrame,
    DiagnosticsRow,
    type BrowserDiagnosticsFamilyPanelProps,
    sanitizeTestIdPart,
} from './BrowserDiagnosticsFamilyPanel';

type StorageSection = Readonly<{ storageType: string; keyCount: number; truncated: boolean; rows: number }>;

/** Sections are presentation over the store's rows: one heading per storage area, in arrival order. */
function storageSections(rows: readonly BrowserDiagnosticStorageRow[]): readonly StorageSection[] {
    const sections = new Map<string, StorageSection>();
    for (const row of rows) {
        const current = sections.get(row.storageType);
        sections.set(row.storageType, {
            storageType: row.storageType,
            keyCount: row.keyCount,
            truncated: row.keysTruncated,
            rows: (current?.rows ?? 0) + 1,
        });
    }
    return [...sections.values()];
}

export function BrowserStoragePanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    const events = props.events;
    const rows = React.useMemo(() => selectBrowserDiagnosticStorageRows({ events }), [events]);
    const sections = React.useMemo(() => storageSections(rows), [rows]);
    const anyValue = rows.some((row) => row.value !== null);
    const selectItems = React.useCallback(
        (_segment: string, query: string) => selectBrowserDiagnosticStorageRows({ events }, { search: query }),
        [events],
    );
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="storage"
            items={rows}
            countLabel={(count) => t('browserDiagnostics.host.devtools.count.keys', { count })}
            note={anyValue ? null : t('browserDiagnostics.host.devtools.storage.valuesHidden')}
            searchPlaceholder={t('browserDiagnostics.host.devtools.search.storage')}
            selectItems={selectItems}
            renderItems={(visible) => sections.map((section) => {
                const sectionRows = visible.filter((row) => row.storageType === section.storageType);
                if (sectionRows.length === 0) return null;
                const sectionID = `${props.testID}-storage-${sanitizeTestIdPart(section.storageType)}`;
                return (
                    <React.Fragment key={section.storageType}>
                        <Text testID={`${sectionID}-title`} style={styles.sectionTitle}>
                            {t('browserDiagnostics.host.devtools.storage.section', {
                                storageType: section.storageType,
                                keys: t('browserDiagnostics.host.devtools.count.keys', { count: section.keyCount }),
                            })}
                        </Text>
                        {sectionRows.map((row, index) => (
                            <DiagnosticsRow
                                key={row.key}
                                testID={`${sectionID}-key-${index}`}
                                subject={row.value !== null ? `${row.name}: ${row.value}${row.valueTruncated ? '…' : ''}` : row.name}
                                copyText={row.value ?? row.name}
                            />
                        ))}
                        {section.truncated ? (
                            <Text style={styles.note}>
                                {t('browserDiagnostics.host.devtools.storage.truncated', { count: section.rows })}
                            </Text>
                        ) : null}
                    </React.Fragment>
                );
            })}
        />
    );
}

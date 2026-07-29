import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import type { BrowserDiagnosticEventProjection } from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

import { BrowserDiagnosticsFidelityBadge } from './BrowserDiagnosticsFidelityBadge';
import {
    browserDiagnosticsPanelStyles,
    BrowserDiagnosticsFamilyPanelFrame,
    type BrowserDiagnosticsFamilyPanelProps,
    eventTitle,
    fieldLabel,
    getBrowserDiagnosticField,
    renderBrowserDiagnosticEventDetail,
    renderPanelField,
    safeEventDetail,
    sanitizeTestIdPart,
} from './BrowserDiagnosticsFamilyPanel';

function renderStorageEvent(
    event: BrowserDiagnosticEventProjection,
    testID: string,
): React.ReactElement {
    const eventId = sanitizeTestIdPart(event.eventId);
    const rowTestID = `${testID}-storage-row-${eventId}`;
    const keys = event.detail?.keys ?? [];
    const storageEntries = event.detail?.storageEntries ?? [];

    return (
        <View key={event.eventId} testID={rowTestID} style={browserDiagnosticsPanelStyles.panelGroup}>
            <View
                testID={`${testID}-event-${eventId}`}
                style={browserDiagnosticsPanelStyles.titleRow}
            >
                <Text style={browserDiagnosticsPanelStyles.panelGroupTitle}>{eventTitle(event)}</Text>
                <BrowserDiagnosticsFidelityBadge
                    fidelity={event.fidelity}
                    testID={`${rowTestID}-fidelity-${event.fidelity}`}
                />
            </View>
            <Text testID={`${testID}-storage-detail-${eventId}`} style={browserDiagnosticsPanelStyles.flowMeta}>
                {safeEventDetail(event)}
            </Text>
            <View style={browserDiagnosticsPanelStyles.panelRow}>
                {renderPanelField({
                    label: fieldLabel('storageType'),
                    value: getBrowserDiagnosticField(event, 'storageType'),
                    testID: `${testID}-storage-meta-${eventId}-type`,
                })}
                {renderPanelField({
                    label: fieldLabel('keyCount'),
                    value: getBrowserDiagnosticField(event, 'keyCount'),
                    testID: `${testID}-storage-meta-${eventId}-count`,
                })}
                {renderPanelField({
                    label: fieldLabel('keysTruncated'),
                    value: getBrowserDiagnosticField(event, 'keysTruncated'),
                    testID: `${testID}-storage-meta-${eventId}-truncated`,
                })}
            </View>
            {keys.length > 0 ? (
                <View testID={`${testID}-storage-keys-${eventId}`} style={browserDiagnosticsPanelStyles.detail}>
                    <Text style={browserDiagnosticsPanelStyles.detailListLabel}>
                        {t('browserDiagnostics.host.detail.keys', { count: String(keys.length) })}
                    </Text>
                    {keys.map((key, index) => (
                        <View
                            key={`${key}-${index}`}
                            testID={`${testID}-storage-key-${eventId}-${index}`}
                            style={browserDiagnosticsPanelStyles.keyRow}
                        >
                            <Text style={browserDiagnosticsPanelStyles.panelValue}>{key}</Text>
                        </View>
                    ))}
                </View>
            ) : null}
            {storageEntries.length > 0 ? (
                <View testID={`${testID}-storage-entries-${eventId}`} style={browserDiagnosticsPanelStyles.detail}>
                    {storageEntries.map((entry, index) => (
                        <View
                            key={`${entry.key}-${index}`}
                            testID={`${testID}-storage-entry-${eventId}-${index}`}
                            style={browserDiagnosticsPanelStyles.keyRow}
                        >
                            <Text style={browserDiagnosticsPanelStyles.panelValue}>
                                {`${entry.key}: ${entry.value}${entry.valueTruncated ? '...' : ''}`}
                            </Text>
                        </View>
                    ))}
                </View>
            ) : null}
            {event.detail ? renderBrowserDiagnosticEventDetail(event.detail, rowTestID) : null}
            {!event.trusted ? (
                <Text style={browserDiagnosticsPanelStyles.warning}>{t('browserDiagnostics.host.untrustedEvent')}</Text>
            ) : null}
        </View>
    );
}

export function BrowserStoragePanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="storage"
            renderEvent={renderStorageEvent}
        />
    );
}

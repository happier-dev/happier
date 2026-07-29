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
    formatBrowserDiagnosticFieldValue,
    renderBrowserDiagnosticEventDetail,
    safeEventDetail,
    sanitizeTestIdPart,
} from './BrowserDiagnosticsFamilyPanel';

function renderResourcesEvent(
    event: BrowserDiagnosticEventProjection,
    testID: string,
): React.ReactElement {
    const eventId = sanitizeTestIdPart(event.eventId);
    const rowTestID = `${testID}-resources-row-${eventId}`;
    const entries = event.detail?.entries ?? [];

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
            <Text testID={`${testID}-resources-detail-${eventId}`} style={browserDiagnosticsPanelStyles.flowMeta}>
                {safeEventDetail(event)}
            </Text>
            {entries.length > 0 ? (
                <View testID={`${testID}-resources-table-${eventId}`} style={browserDiagnosticsPanelStyles.detail}>
                    {entries.map((entry, index) => (
                        <View
                            key={`${entry.name ?? 'resource'}-${index}`}
                            testID={`${testID}-resources-entry-${eventId}-${index}`}
                            style={browserDiagnosticsPanelStyles.panelRow}
                        >
                            {entry.name ? (
                                <View testID={`${testID}-resources-entry-${eventId}-${index}-name`} style={browserDiagnosticsPanelStyles.panelCellWide}>
                                    <Text style={browserDiagnosticsPanelStyles.panelLabel}>{fieldLabel('url')}</Text>
                                    <Text style={browserDiagnosticsPanelStyles.panelValue}>{entry.name}</Text>
                                </View>
                            ) : null}
                            {entry.initiatorType ? (
                                <View testID={`${testID}-resources-entry-${eventId}-${index}-type`} style={browserDiagnosticsPanelStyles.panelCell}>
                                    <Text style={browserDiagnosticsPanelStyles.panelLabel}>{t('browserDiagnostics.host.fields.type')}</Text>
                                    <Text style={browserDiagnosticsPanelStyles.panelValue}>{entry.initiatorType}</Text>
                                </View>
                            ) : null}
                            {typeof entry.durationMs === 'number' ? (
                                <View testID={`${testID}-resources-entry-${eventId}-${index}-duration`} style={browserDiagnosticsPanelStyles.panelCell}>
                                    <Text style={browserDiagnosticsPanelStyles.panelLabel}>{fieldLabel('durationMs')}</Text>
                                    <Text style={browserDiagnosticsPanelStyles.panelValue}>
                                        {formatBrowserDiagnosticFieldValue(entry.durationMs)}
                                    </Text>
                                </View>
                            ) : null}
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

export function BrowserResourcesPanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="resources"
            renderEvent={renderResourcesEvent}
        />
    );
}

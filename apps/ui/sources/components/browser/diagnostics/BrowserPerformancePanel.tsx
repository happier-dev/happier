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
    renderBrowserDiagnosticEventDetail,
    renderPanelMetric,
    safeEventDetail,
    sanitizeTestIdPart,
} from './BrowserDiagnosticsFamilyPanel';

function renderPerformanceEvent(
    event: BrowserDiagnosticEventProjection,
    testID: string,
): React.ReactElement {
    const eventId = sanitizeTestIdPart(event.eventId);
    const rowTestID = `${testID}-performance-row-${eventId}`;

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
            <Text testID={`${testID}-performance-detail-${eventId}`} style={browserDiagnosticsPanelStyles.flowMeta}>
                {safeEventDetail(event)}
            </Text>
            <View testID={`${testID}-performance-metrics-${eventId}`} style={browserDiagnosticsPanelStyles.metricGrid}>
                {(event.detail?.fields ?? []).map((field) => {
                    const fieldId = sanitizeTestIdPart(field.key);
                    const metric = renderPanelMetric({
                        label: fieldLabel(field.key),
                        value: field.value,
                        testID: `${testID}-performance-metric-${eventId}-${fieldId}`,
                    });
                    return metric ? React.cloneElement(metric, { key: field.key }) : null;
                })}
            </View>
            {event.detail ? renderBrowserDiagnosticEventDetail(event.detail, rowTestID) : null}
            {!event.trusted ? (
                <Text style={browserDiagnosticsPanelStyles.warning}>{t('browserDiagnostics.host.untrustedEvent')}</Text>
            ) : null}
        </View>
    );
}

export function BrowserPerformancePanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="performance"
            renderEvent={renderPerformanceEvent}
        />
    );
}

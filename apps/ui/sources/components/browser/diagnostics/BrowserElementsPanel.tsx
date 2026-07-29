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
    renderPanelMetric,
    safeEventDetail,
    sanitizeTestIdPart,
} from './BrowserDiagnosticsFamilyPanel';

const ELEMENT_TREE_FIELDS = ['nodeCount', 'elementCount', 'maxDepth', 'readyState'] as const;

function renderElementsEvent(
    event: BrowserDiagnosticEventProjection,
    testID: string,
): React.ReactElement {
    const eventId = sanitizeTestIdPart(event.eventId);
    const rowTestID = `${testID}-elements-row-${eventId}`;
    const isSelection = event.kind === 'elements.pickerState';

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
            <Text testID={`${testID}-elements-detail-${eventId}`} style={browserDiagnosticsPanelStyles.flowMeta}>
                {safeEventDetail(event)}
            </Text>
            {isSelection ? (
                <View testID={`${testID}-elements-selection-${eventId}`} style={browserDiagnosticsPanelStyles.panelRow}>
                    {renderPanelField({
                        label: fieldLabel('state'),
                        value: getBrowserDiagnosticField(event, 'state'),
                        testID: `${testID}-elements-selection-${eventId}-state`,
                    })}
                    {renderPanelField({
                        label: fieldLabel('selectorPath'),
                        value: getBrowserDiagnosticField(event, 'selectorPath'),
                        testID: `${testID}-elements-selection-${eventId}-selector`,
                        wide: true,
                    })}
                    {renderPanelField({
                        label: fieldLabel('backendNodeRef'),
                        value: getBrowserDiagnosticField(event, 'backendNodeRef'),
                        testID: `${testID}-elements-selection-${eventId}-backendNode`,
                    })}
                    {renderPanelField({
                        label: fieldLabel('rectAvailable'),
                        value: getBrowserDiagnosticField(event, 'rectAvailable'),
                        testID: `${testID}-elements-selection-${eventId}-rect`,
                    })}
                    {renderPanelField({
                        label: fieldLabel('accessibleNameAvailable'),
                        value: getBrowserDiagnosticField(event, 'accessibleNameAvailable'),
                        testID: `${testID}-elements-selection-${eventId}-a11y`,
                    })}
                </View>
            ) : (
                <View testID={`${testID}-elements-tree-${eventId}`} style={browserDiagnosticsPanelStyles.metricGrid}>
                    {ELEMENT_TREE_FIELDS.map((key) => {
                        const metric = renderPanelMetric({
                            label: fieldLabel(key),
                            value: getBrowserDiagnosticField(event, key),
                            testID: `${testID}-elements-tree-${eventId}-${key}`,
                        });
                        return metric ? React.cloneElement(metric, { key }) : null;
                    })}
                </View>
            )}
            {event.detail ? renderBrowserDiagnosticEventDetail(event.detail, rowTestID) : null}
            {!event.trusted ? (
                <Text style={browserDiagnosticsPanelStyles.warning}>{t('browserDiagnostics.host.untrustedEvent')}</Text>
            ) : null}
        </View>
    );
}

export function BrowserElementsPanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="elements"
            renderEvent={renderElementsEvent}
        />
    );
}

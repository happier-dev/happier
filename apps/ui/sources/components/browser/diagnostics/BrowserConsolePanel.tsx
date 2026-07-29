import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import type { BrowserDiagnosticEventProjection } from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

import { BrowserDiagnosticsFidelityBadge } from './BrowserDiagnosticsFidelityBadge';
import {
    browserDiagnosticsPanelStyles,
    BrowserDiagnosticsFamilyPanelFrame,
    type BrowserDiagnosticsProductFamilyKey,
    type BrowserDiagnosticsFamilyPanelProps,
    eventTitle,
    fieldLabel,
    getBrowserDiagnosticField,
    getBrowserDiagnosticFieldText,
    renderPanelField,
    safeEventDetail,
    sanitizeTestIdPart,
} from './BrowserDiagnosticsFamilyPanel';

function renderConsoleEvent(
    event: BrowserDiagnosticEventProjection,
    testID: string,
    familyKey: BrowserDiagnosticsProductFamilyKey,
): React.ReactElement {
    const eventId = sanitizeTestIdPart(event.eventId);
    const rowTestID = `${testID}-${familyKey}-row-${eventId}`;
    const detailTestID = `${testID}-${familyKey}-detail-${eventId}`;
    const text = getBrowserDiagnosticFieldText(event, 'text') ?? safeEventDetail(event);
    const level = getBrowserDiagnosticField(event, 'level');
    const argCount = getBrowserDiagnosticField(event, 'argCount');

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
            <Text testID={detailTestID} style={browserDiagnosticsPanelStyles.flowMeta}>
                {safeEventDetail(event)}
            </Text>
            <Text
                testID={`${testID}-${familyKey}-entry-${eventId}-text`}
                style={browserDiagnosticsPanelStyles.consoleMessage}
            >
                {text}
            </Text>
            <View style={browserDiagnosticsPanelStyles.panelRow}>
                {renderPanelField({
                    label: fieldLabel('level'),
                    value: level,
                    testID: `${testID}-${familyKey}-entry-${eventId}-level`,
                })}
                {renderPanelField({
                    label: fieldLabel('argCount'),
                    value: argCount,
                    testID: `${testID}-${familyKey}-entry-${eventId}-arguments`,
                })}
            </View>
            {!event.trusted ? (
                <Text style={browserDiagnosticsPanelStyles.warning}>{t('browserDiagnostics.host.untrustedEvent')}</Text>
            ) : null}
        </View>
    );
}

export function BrowserConsolePanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="console"
            renderEvent={renderConsoleEvent}
        />
    );
}

export function BrowserPageErrorPanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="pageError"
            renderEvent={renderConsoleEvent}
        />
    );
}

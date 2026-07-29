import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import type {
    BrowserDiagnosticEventProjection,
    BrowserDiagnosticFamilyProjection,
    BrowserDiagnosticsPanelProjection,
    BrowserPreviewProxyDiagnosticsProjection,
    BrowserPreviewProxyFlowProjection,
    BrowserViewDiagnosticsProjection,
} from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

import { BrowserConsolePanel, BrowserPageErrorPanel } from './BrowserConsolePanel';
import {
    browserDiagnosticsPanelStyles as stylesheet,
    familyLabel,
    formatNumber,
    renderBrowserDiagnosticEvent,
    sanitizeTestIdPart,
    statusLabel,
} from './BrowserDiagnosticsFamilyPanel';
import { BrowserDiagnosticsFidelityBadge } from './BrowserDiagnosticsFidelityBadge';
import {
    BrowserDiagnosticsInteractionPanel,
    type BrowserDiagnosticsInteractionControls,
    type BrowserDiagnosticsInteractionSurface,
} from './BrowserDiagnosticsInteractionPanel';
import { BrowserElementsPanel } from './BrowserElementsPanel';
import { BrowserNetworkPanel } from './BrowserNetworkPanel';
import { BrowserPageInfoPanel } from './BrowserPageInfoPanel';
import { BrowserPerformancePanel } from './BrowserPerformancePanel';
import { BrowserResourcesPanel } from './BrowserResourcesPanel';
import { BrowserStoragePanel } from './BrowserStoragePanel';

function flowTitle(flow: BrowserPreviewProxyFlowProjection): string {
    if (flow.method || flow.path || typeof flow.statusCode === 'number') {
        return t('browserDiagnostics.previewProxy.httpFlow', {
            method: flow.method ?? 'HTTP',
            path: flow.path ?? '/',
            statusCode: typeof flow.statusCode === 'number' ? String(flow.statusCode) : '-',
        });
    }
    if (flow.websocketSubprotocol) {
        return t('browserDiagnostics.previewProxy.webSocketFlow', { subprotocol: flow.websocketSubprotocol });
    }
    return t('browserDiagnostics.previewProxy.tunnelFlow', { flowId: flow.flowId });
}

function renderFlow(flow: BrowserPreviewProxyFlowProjection, testID: string): React.ReactElement {
    const rowTestID = `${testID}-flow-${sanitizeTestIdPart(flow.flowId)}`;
    return (
        <View key={flow.flowId} testID={rowTestID} style={stylesheet.flowRow}>
            <Text style={stylesheet.flowTitle}>{flowTitle(flow)}</Text>
            <Text style={stylesheet.flowMeta}>
                {t('browserDiagnostics.previewProxy.flowBytes', {
                    bytesIn: formatNumber(flow.bytesIn),
                    bytesOut: formatNumber(flow.bytesOut),
                })}
            </Text>
            <Text style={stylesheet.flowMeta}>
                {t('browserDiagnostics.previewProxy.flowMessages', {
                    messagesIn: formatNumber(flow.messagesIn),
                    messagesOut: formatNumber(flow.messagesOut),
                })}
            </Text>
        </View>
    );
}

function renderHostDiagnosticEvent(event: BrowserDiagnosticEventProjection, testID: string): React.ReactElement {
    return renderBrowserDiagnosticEvent(event, testID);
}

function renderHostDiagnosticFamily(params: Readonly<{
    family: BrowserDiagnosticFamilyProjection;
    events: readonly BrowserDiagnosticEventProjection[];
    testID: string;
}>): React.ReactElement {
    const familyEvents = params.events.filter((event) => event.family === params.family.family);
    const familyTestID = `${params.testID}-family-${params.family.family}`;
    return (
        <View key={params.family.family} testID={familyTestID} style={stylesheet.familySection}>
            <View style={stylesheet.titleRow}>
                <Text style={stylesheet.flowTitle}>{params.family.family}</Text>
                <BrowserDiagnosticsFidelityBadge
                    fidelity={params.family.fidelity}
                    testID={`${familyTestID}-fidelity-${params.family.fidelity}`}
                />
            </View>
            <Text style={stylesheet.flowMeta}>
                {params.family.status === 'unavailable'
                    ? familyLabel(params.family)
                    : t('browserDiagnostics.host.eventCount', {
                        count: formatNumber(familyEvents.length),
                    })}
            </Text>
            {familyEvents.length > 0 ? (
                familyEvents.map((event) => renderHostDiagnosticEvent(event, params.testID))
            ) : null}
        </View>
    );
}

type BrowserDiagnosticsProductPanelComponent = React.ComponentType<{
    family: BrowserDiagnosticFamilyProjection;
    events: readonly BrowserDiagnosticEventProjection[];
    testID: string;
}>;

const PRODUCT_DIAGNOSTIC_PANELS: readonly {
    family: BrowserDiagnosticFamilyProjection['family'];
    Component: BrowserDiagnosticsProductPanelComponent;
}[] = [
    { family: 'console', Component: BrowserConsolePanel },
    { family: 'pageError', Component: BrowserPageErrorPanel },
    { family: 'network', Component: BrowserNetworkPanel },
    { family: 'elements', Component: BrowserElementsPanel },
    { family: 'resources', Component: BrowserResourcesPanel },
    { family: 'storage', Component: BrowserStoragePanel },
    { family: 'pageInfo', Component: BrowserPageInfoPanel },
    { family: 'performance', Component: BrowserPerformancePanel },
];

function renderHostDiagnosticPanels(
    diagnostics: BrowserViewDiagnosticsProjection,
    testID: string,
): readonly React.ReactElement[] {
    const productFamilyNames = new Set(PRODUCT_DIAGNOSTIC_PANELS.map((panel) => panel.family));
    const panels: React.ReactElement[] = [];

    for (const { family: familyName, Component } of PRODUCT_DIAGNOSTIC_PANELS) {
        const family = diagnostics.families.find((candidate) => candidate.family === familyName);
        if (!family) continue;
        panels.push(
            <Component
                key={family.family}
                family={family}
                events={diagnostics.events.filter((event) => event.family === family.family)}
                testID={testID}
            />,
        );
    }

    for (const family of diagnostics.families) {
        if (productFamilyNames.has(family.family)) continue;
        panels.push(renderHostDiagnosticFamily({
            family,
            events: diagnostics.events,
            testID,
        }));
    }

    return panels;
}

function BrowserPreviewProxyDiagnosticsPanel(props: Readonly<{
    diagnostics: BrowserPreviewProxyDiagnosticsProjection;
    testID: string;
}>): React.ReactElement {
    const unavailableFamilies = props.diagnostics.families.filter((family) => family.status === 'unavailable');

    return (
        <>
            <View style={stylesheet.header}>
                <View style={stylesheet.titleRow}>
                    <Text style={stylesheet.title}>{t('browserDiagnostics.previewProxy.title')}</Text>
                    <BrowserDiagnosticsFidelityBadge
                        fidelity={props.diagnostics.fidelity}
                        testID={`${props.testID}-fidelity-${props.diagnostics.fidelity}`}
                    />
                </View>
                <Text testID={`${props.testID}-status`} style={stylesheet.status}>
                    {statusLabel(props.diagnostics.status)}
                </Text>
                <Text testID={`${props.testID}-active-flow-count`} style={stylesheet.subtitle}>
                    {t('browserDiagnostics.previewProxy.activeFlows', {
                        count: formatNumber(props.diagnostics.activeFlowCount),
                    })}
                </Text>
                <Text style={stylesheet.subtitle}>{t('browserDiagnostics.previewProxy.attributionAllViews')}</Text>
                {props.diagnostics.status === 'stale' ? (
                    <Text testID={`${props.testID}-stale`} style={stylesheet.warning}>
                        {t('browserDiagnostics.previewProxy.staleNotice')}
                    </Text>
                ) : null}
                {props.diagnostics.status === 'unavailable' ? (
                    <Text testID={`${props.testID}-unavailable`} style={stylesheet.warning}>
                        {t('browserDiagnostics.previewProxy.unavailableReason', {
                            reasonCode: props.diagnostics.unavailableReasonCode ?? 'observability_unavailable',
                        })}
                    </Text>
                ) : null}
            </View>

            <View style={stylesheet.content}>
                {props.diagnostics.flows.length > 0 ? (
                    props.diagnostics.flows.map((flow) => renderFlow(flow, props.testID))
                ) : (
                    <Text testID={`${props.testID}-network-empty`} style={stylesheet.subtitle}>
                        {t('browserDiagnostics.previewProxy.networkEmpty')}
                    </Text>
                )}
            </View>

            {unavailableFamilies.length > 0 ? (
                <View style={stylesheet.familyList}>
                    {unavailableFamilies.map((family) => (
                        <View
                            key={family.family}
                            testID={`${props.testID}-family-${family.family}-unavailable`}
                            style={stylesheet.familyPill}
                        >
                            <Text style={stylesheet.familyText}>{familyLabel(family)}</Text>
                        </View>
                    ))}
                </View>
            ) : null}
        </>
    );
}

function BrowserHostDiagnosticsPanel(props: Readonly<{
    diagnostics: BrowserViewDiagnosticsProjection;
    interaction?: BrowserDiagnosticsInteractionControls;
    interactionSurface?: BrowserDiagnosticsInteractionSurface;
    testID: string;
}>): React.ReactElement {
    const unavailableFamilies = props.diagnostics.families.filter((family) => family.status === 'unavailable');

    return (
        <>
            <View style={stylesheet.header}>
                <View style={stylesheet.titleRow}>
                    <Text style={stylesheet.title}>{t('browserDiagnostics.host.title')}</Text>
                    <BrowserDiagnosticsFidelityBadge
                        fidelity={props.diagnostics.fidelity}
                        testID={`${props.testID}-fidelity-${props.diagnostics.fidelity}`}
                    />
                </View>
                <Text testID={`${props.testID}-status`} style={stylesheet.status}>
                    {statusLabel(props.diagnostics.status)}
                </Text>
                <Text testID={`${props.testID}-event-count`} style={stylesheet.subtitle}>
                    {t('browserDiagnostics.host.eventCount', {
                        count: formatNumber(props.diagnostics.eventCount),
                    })}
                </Text>
                {!props.diagnostics.trusted ? (
                    <Text testID={`${props.testID}-untrusted`} style={stylesheet.warning}>
                        {t('browserDiagnostics.host.untrustedNotice')}
                    </Text>
                ) : null}
            </View>

            {props.interaction ? (
                <BrowserDiagnosticsInteractionPanel
                    controls={props.interaction}
                    surface={props.interactionSurface}
                    testID={props.testID}
                />
            ) : null}

            <View style={stylesheet.content}>
                {props.diagnostics.families.length > 0 ? (
                    renderHostDiagnosticPanels(props.diagnostics, props.testID)
                ) : props.diagnostics.events.length > 0 ? (
                    props.diagnostics.events.map((event) => renderHostDiagnosticEvent(event, props.testID))
                ) : (
                    <Text testID={`${props.testID}-events-empty`} style={stylesheet.subtitle}>
                        {t('browserDiagnostics.host.eventsEmpty')}
                    </Text>
                )}
            </View>

            {unavailableFamilies.length > 0 ? (
                <View style={stylesheet.familyList}>
                    {unavailableFamilies.map((family) => (
                        <View
                            key={family.family}
                            testID={`${props.testID}-family-${family.family}-unavailable`}
                            style={stylesheet.familyPill}
                        >
                            <Text style={stylesheet.familyText}>{familyLabel(family)}</Text>
                        </View>
                    ))}
                </View>
            ) : null}
        </>
    );
}

export function BrowserDiagnosticsPanel(props: Readonly<{
    diagnostics: BrowserDiagnosticsPanelProjection;
    interaction?: BrowserDiagnosticsInteractionControls;
    interactionSurface?: BrowserDiagnosticsInteractionSurface;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'browser-diagnostics';

    return (
        <View testID={testID} style={stylesheet.root}>
            {props.diagnostics.sourceKind === 'previewProxy' ? (
                <BrowserPreviewProxyDiagnosticsPanel diagnostics={props.diagnostics} testID={testID} />
            ) : (
                <BrowserHostDiagnosticsPanel
                    diagnostics={props.diagnostics}
                    interaction={props.interaction}
                    interactionSurface={props.interactionSurface}
                    testID={testID}
                />
            )}
        </View>
    );
}

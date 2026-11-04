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
    DiagnosticsFieldList,
    DiagnosticsRow,
    diagnosticFamilyLabel,
    formatBytes,
    formatNumber,
    renderBrowserDiagnosticEvent,
    sanitizeTestIdPart,
    sourceLabel,
    statusLabel,
} from './BrowserDiagnosticsFamilyPanel';
import { BrowserDiagnosticsEvalConsole } from './BrowserDiagnosticsEvalConsole';
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

function renderFlow(flow: BrowserPreviewProxyFlowProjection, testID: string): React.ReactElement {
    const rowTestID = `${testID}-flow-${sanitizeTestIdPart(flow.flowId)}`;
    const failed = typeof flow.statusCode === 'number' && flow.statusCode >= 400;
    const lead = flow.websocketSubprotocol ? 'WS' : (flow.method ?? (flow.path ? 'HTTP' : null));
    const subject = flow.path ?? flow.websocketSubprotocol ?? t('browserDiagnostics.previewProxy.tunnelFlow', { flowId: flow.flowId });
    const fields = [
        { key: 'bytes', label: t('browserDiagnostics.host.devtools.network.size'), value: t('browserDiagnostics.previewProxy.flowBytes', { bytesIn: formatNumber(flow.bytesIn), bytesOut: formatNumber(flow.bytesOut) }) },
        { key: 'messages', label: t('browserDiagnostics.host.fields.messages'), value: t('browserDiagnostics.previewProxy.flowMessages', { messagesIn: formatNumber(flow.messagesIn), messagesOut: formatNumber(flow.messagesOut) }) },
    ];
    return (
        <DiagnosticsRow
            key={flow.flowId}
            testID={rowTestID}
            tone={failed ? 'danger' : 'neutral'}
            lead={lead}
            subject={subject}
            meta={[
                typeof flow.statusCode === 'number' ? { text: String(flow.statusCode), tone: failed ? 'danger' : undefined } : null,
                { text: formatBytes(flow.bytesIn + flow.bytesOut) },
            ]}
            renderDetail={() => <DiagnosticsFieldList fields={fields} testID={`${rowTestID}-detail`} />}
        />
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
            <View style={stylesheet.header}>
                <Text style={stylesheet.title}>{diagnosticFamilyLabel(params.family.family)}</Text>
                <Text style={stylesheet.stateLine}>
                    {params.family.status === 'unavailable'
                        ? t('browserDiagnostics.host.familyNotReported')
                        : [
                            t('browserDiagnostics.host.devtools.count.entries', { count: familyEvents.length }),
                            sourceLabel(params.family.fidelity, params.family.trusted),
                        ].filter(Boolean).join(' · ')}
                </Text>
            </View>
            {familyEvents.length > 0 ? (
                familyEvents.map((event) => renderHostDiagnosticEvent(event, params.testID))
            ) : null}
        </View>
    );
}

type BrowserDiagnosticsProductPanelComponent = React.ComponentType<{
    family: BrowserDiagnosticFamilyProjection;
    events: readonly BrowserDiagnosticEventProjection[];
    projection?: BrowserViewDiagnosticsProjection;
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
                projection={diagnostics}
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

    const stateLine = [
        t('browserDiagnostics.previewProxy.activeFlows', { count: formatNumber(props.diagnostics.activeFlowCount) }),
        t('browserDiagnostics.previewProxy.attributionAllViews'),
    ].join(' · ');

    return (
        <>
            <View style={stylesheet.header}>
                <Text testID={`${props.testID}-status`} style={stylesheet.stateLine}>
                    {props.diagnostics.status === 'available' ? stateLine : statusLabel(props.diagnostics.status)}
                </Text>
                {props.diagnostics.status === 'stale' ? (
                    <Text testID={`${props.testID}-stale`} style={stylesheet.warning}>
                        {t('browserDiagnostics.previewProxy.staleNotice')}
                    </Text>
                ) : null}
                {props.diagnostics.status === 'unavailable' ? (
                    <Text testID={`${props.testID}-unavailable`} style={stylesheet.subtitle}>
                        {t('browserDiagnostics.host.devtools.unavailable.previewReason')}
                    </Text>
                ) : null}
            </View>

            {props.diagnostics.flows.length > 0 ? (
                <View>{props.diagnostics.flows.map((flow) => renderFlow(flow, props.testID))}</View>
            ) : (
                <Text testID={`${props.testID}-network-empty`} style={stylesheet.note}>
                    {t('browserDiagnostics.previewProxy.networkEmpty')}
                </Text>
            )}

            {unavailableFamilies.length > 0 ? (
                <Text testID={`${props.testID}-families-unavailable`} style={stylesheet.note}>
                    {t('browserDiagnostics.host.devtools.unavailable.previewFamilies', {
                        families: unavailableFamilies.map((family) => diagnosticFamilyLabel(family.family)).join(', '),
                    })}
                </Text>
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
    // A page that has reported nothing is one fact with one reason. Its tools, per-family sections,
    // badges, counts and tamper notice would each restate a capture that is not happening.
    if (props.diagnostics.status === 'unavailable') {
        return (
            <View style={stylesheet.header}>
                <Text testID={`${props.testID}-status`} style={stylesheet.title}>
                    {t('browserDiagnostics.host.devtools.unavailable.title')}
                </Text>
                <Text testID={`${props.testID}-unavailable-reason`} style={stylesheet.subtitle}>
                    {props.diagnostics.reasonCode === 'unsupported_engine' || props.diagnostics.reasonCode === 'engine_unsupported'
                        || props.diagnostics.reasonCode === 'cross_origin_frame_unavailable'
                        ? t('browserDiagnostics.host.devtools.unavailable.directPage')
                        : t('browserDiagnostics.host.devtools.unavailable.reason')}
                </Text>
            </View>
        );
    }

    // A drawer section is one tool: its own state line says what it has. Only the overview of several
    // tools needs the one line naming what the page reports to and how much it has said.
    const overview = props.diagnostics.families.length !== 1;
    const tools = props.diagnostics.families
        .filter((family) => family.status !== 'unavailable')
        .map((family) => diagnosticFamilyLabel(family.family));
    const eventCount = t('browserDiagnostics.host.devtools.count.entries', { count: props.diagnostics.eventCount });
    return (
        <>
            {overview ? (
                <View style={stylesheet.header}>
                    <Text testID={`${props.testID}-status`} style={stylesheet.stateLine}>
                        {tools.length > 0 ? `${tools.join(', ')} · ${eventCount}` : eventCount}
                    </Text>
                </View>
            ) : null}

            {props.interaction ? (
                <BrowserDiagnosticsInteractionPanel
                    controls={props.interaction}
                    surface={props.interactionSurface}
                    testID={props.testID}
                />
            ) : null}

            <View style={stylesheet.familySection}>
                {props.diagnostics.families.length > 0 ? (
                    renderHostDiagnosticPanels(props.diagnostics, props.testID)
                ) : props.diagnostics.events.length > 0 ? (
                    props.diagnostics.events.map((event) => renderHostDiagnosticEvent(event, props.testID))
                ) : (
                    <Text testID={`${props.testID}-events-empty`} style={stylesheet.note}>
                        {t('browserDiagnostics.host.devtools.empty')}
                    </Text>
                )}
            </View>

            {/* The REPL is the console's input line: it follows the log, as in every devtools console. */}
            {props.interaction?.state === 'enabled' && props.interaction.evalConsole
                && (props.interactionSurface === 'console' || props.interactionSurface === 'all' || !props.interactionSurface) ? (
                <BrowserDiagnosticsEvalConsole controls={props.interaction.evalConsole} testID={`${props.testID}-eval`} />
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

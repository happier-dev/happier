import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HubUsageCardGrid } from '@/components/hub/usage/HubUsageCardGrid';
import { ConnectedAccountDeviceForm } from '@/components/settings/connectedServices/account/ConnectedAccountDeviceForm';
import { ConnectedAccountManualForm } from '@/components/settings/connectedServices/account/ConnectedAccountManualForm';
import { ConnectedAccountOAuthForm } from '@/components/settings/connectedServices/account/ConnectedAccountOAuthForm';
import { ProviderUsageGaugeSettingsGroup } from '@/components/settings/connectedServices/ProviderUsageGaugeSettingsGroup';
import { CONNECTED_SERVICES_USAGE_GAUGE_SETTINGS } from '@/components/settings/connectedServices/connectedServicesSettings';
import { getConnectedServiceSetupPresentation } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { buildConnectServicesSetupItem } from '@/components/settings/connectedServices/home/useConnectServicesSetupItem';
import { selectHomeConnectInvitations } from '@/components/settings/connectedServices/home/selectHomeConnectInvitations';
import {
    buildConnectedServicesIndexModel,
    type ConnectedServicesIndexModel,
} from '@/components/settings/connectedServices/model/buildConnectedServicesIndexModel';
import { buildConnectedServiceSetupCatalog } from '@/components/settings/connectedServices/setup/buildConnectedServiceSetupCatalog';
import { ConnectedServiceSetupFlowBody } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupFlowBody';
import type {
    ConnectedServiceSetupCatalogEntry,
    ConnectedServiceSetupTarget,
} from '@/components/settings/connectedServices/setup/ConnectedServiceSetupPanel';
import { ConnectedServicesConnectMore } from '@/components/settings/connectedServices/setup/ConnectedServicesConnectMore';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SetupBlockGrid, type SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { SetupBlockTile } from '@/components/ui/setupBlocks/SetupBlockTile';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';

import {
    ACCOUNTS, AGENT_USES, CHATGPT, CHATGPT_BOT, CLAUDE, CODEX_POOL, DAY, ENTRIES, GEMINI, GROUPS, HOUR, LABELS, MIN,
} from './connectedServicesFixtures';
import { renderCollectionFrame } from './collectionFrames';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';

const noop = () => {};
const fixtureTarget = { serverIdentityId: 'fixture-home', machineId: 'fixture-macbook' };
const fixtureMachine = { target: fixtureTarget, displayName: 'MacBook Pro', serverLabel: 'Personal Home', availability: 'online' as const,
    observation: 'live' as const, observedAt: Date.now() };
const FIXTURE_SELECTION: MachineAdministrationTargetSelectionV1 = {
    candidates: [fixtureMachine], pickerRows: [], selectedTarget: fixtureTarget,
    state: { kind: 'online', target: fixtureTarget, machine: fixtureMachine },
    selectedTargetServerMatchesActiveAccount: false, canExecute: false,
    selectTarget: noop, clearTarget: noop, resolveExecutionTarget: () => null,
};
const SETUP_FRAMES = new Set(['A1', 'A2', 'A3', 'A4', 'A5', 'AS', 'P0', 'H2', 'H2c', 'H2b']);
const CHATGPT_KEY = 'happier.agent.codex/openai-codex';
const CLAUDE_KEY = 'happier.agent.claude/claude-subscription';
const ANTHROPIC_KEY = 'happier.agent.claude/anthropic';

/**
 * Dev-only `/dev/connected-services` frames of the setup slice (lab `csvc` A1–A5, AS, P0, H2, H2c, H2b;
 * the phone twins are the same frames at 390). Fixtures go through the real set-up owners; a flow is
 * drawn by the real forms at fixture attempts (no machine). Null for a frame it does not own.
 */
export function renderSetupFrame(frame: string): React.ReactNode | null {
    const id = frame.endsWith('p') && SETUP_FRAMES.has(frame.slice(0, -1)) ? frame.slice(0, -1) : frame;
    switch (id) {
        case 'A1': return <ConnectMoreFrame request={{ kind: 'catalog' }} />;
        case 'A2': return <ConnectMoreFrame request={{ kind: 'service', serviceKey: CHATGPT_KEY }} />;
        case 'A3': return <ConnectMoreFrame request={{ kind: 'service', serviceKey: CLAUDE_KEY }} />;
        case 'A4': return <ConnectMoreFrame request={{ kind: 'service', serviceKey: ANTHROPIC_KEY }} />;
        // A5: the connected account settles into its row on the index (the collection slice's frame).
        case 'A5': return renderCollectionFrame('A5');
        case 'AS': return <SetupStatesFrame />;
        case 'P0': return <FirstRunFrame />;
        case 'H2': return <HomeFrame stage="rest" />;
        case 'H2c': return <HomeFrame stage="open" />;
        case 'H2b': return <HomeFrame stage="after" />;
        default: return null;
    }
}

function useModel(input: Readonly<{ accounts: boolean; extra?: boolean }>): ConnectedServicesIndexModel {
    return React.useMemo(() => buildConnectedServicesIndexModel({
        transport: 'advertised-v4',
        entries: ENTRIES,
        qualifiedAccounts: input.accounts ? (input.extra ? [...ACCOUNTS, CHATGPT_BOT] : ACCOUNTS) : [],
        qualifiedGroups: input.accounts ? (input.extra ? [...GROUPS, CODEX_POOL] : GROUPS) : [],
        legacyServices: [],
        defaultAccountByServiceKey: {},
        resolveLabel: (candidate) => String(candidate?.projectedTitle ?? ''),
        resolveFallbackEntry: () => null,
        presentDiagnostics: () => ({ primary: null, supportDetails: null }),
        loadingLabel: t('common.loading'),
        // A5: Codex signs in through its pool.
        agentUses: input.extra
            ? AGENT_USES.map((use) => use.title === 'Codex'
                ? { ...use, defaults: [{ kind: 'group' as const, service: CHATGPT, groupId: 'codex-pool' }] }
                : use)
            : AGENT_USES,
    }), [input.accounts, input.extra]);
}

/** One service's flow at a fixture attempt: the real forms, as the controller renders them. */
function FixtureFlow(props: Readonly<{ entry: ConnectedServiceSetupCatalogEntry; target: ConnectedServiceSetupTarget }>) {
    const key = props.entry.serviceKey;
    if (key === CHATGPT_KEY) {
        return (
            <ConnectedServiceSetupFlowBody
                state="ready"
                methods={[
                    { id: 'device', title: t('connectedServicesSettings.methodCode'), recommended: true },
                    { id: 'oauth', title: t('connectedServicesSettings.methodBrowser'), recommended: false },
                ]}
                activeMethodId="device"
                onSelectMethod={noop}
                flow={(
                    <ConnectedAccountDeviceForm
                        embedded
                        verificationUri="https://chatgpt.com/device"
                        userCode="WDJB-MJHT"
                        expiresAtMs={Date.now() + 14 * MIN + 32 * 1000}
                        serviceTitle="ChatGPT"
                        busy={false}
                        onCancel={noop}
                        onPoll={noop}
                        onResume={noop}
                    />
                )}
            />
        );
    }
    if (key === CLAUDE_KEY) {
        return (
            <ConnectedServiceSetupFlowBody
                state="ready"
                methods={[
                    { id: 'oauth', title: t('connectedServicesSettings.methodBrowser'), recommended: true },
                    { id: 'setup-token', title: t('connectedServicesSettings.methodToken'), recommended: false },
                ]}
                activeMethodId="oauth"
                onSelectMethod={noop}
                flow={(
                    <ConnectedAccountOAuthForm
                        embedded
                        authorizationUrl="https://claude.ai/oauth/authorize?client_id=…"
                        callbackUrl="https://platform.claude.com/oauth/code/callback"
                        submitting={false}
                        onCancel={noop}
                        onSubmit={noop}
                    />
                )}
            />
        );
    }
    const presentation = getConnectedServiceSetupPresentation(props.entry.service);
    const guide = presentation && 'manual' in presentation ? presentation.manual : null;
    return (
        <ConnectedServiceSetupFlowBody
            state="ready"
            flow={(
                <ConnectedAccountManualForm
                    embedded
                    title={props.entry.label}
                    fields={[{ id: 'token', title: props.entry.label, secret: true, schema: { type: 'string', minLength: 1 } }]}
                    guided={guide ? { consoleUrl: guide.consoleUrl, createKeyTitle: t(guide.createKeyTitleKey),
                        billingNote: t(guide.billingNoteKey), shapeHint: t(guide.shapeHintKey) } : undefined}
                    submitting={false}
                    onCancel={noop}
                    onSubmit={noop}
                />
            )}
        />
    );
}

const renderFixtureFlow = (entry: ConnectedServiceSetupCatalogEntry, target: ConnectedServiceSetupTarget) => (
    <FixtureFlow entry={entry} target={target} />
);

/** A1–A4: "Connect more", opened by the request the page's "+" / "Add account" sends. */
function ConnectMoreFrame(props: Readonly<{ request: ConnectedServiceSetupTarget }>) {
    const phone = useDeviceType() === 'phone';
    const model = useModel({ accounts: true });
    const [request, setRequest] = React.useState<ConnectedServiceSetupTarget | null>(props.request);
    return (
        <ItemList>
            {!phone ? <PageHeader title={t('settings.connectedServices')} description={t('settings.connectedServicesSubtitle')} /> : null}
            <ConnectedServicesConnectMore
                model={model}
                layout="section"
                request={request}
                onRequestHandled={() => setRequest(null)}
                onConnected={noop}
                renderServiceFlow={renderFixtureFlow}
                targetSelection={FIXTURE_SELECTION}
            />
        </ItemList>
    );
}

/** P0: nothing connected yet — the promise, then the plans your agents accept. */
function FirstRunFrame() {
    const model = useModel({ accounts: false });
    return (
        <ItemList>
            <ItemGroup surface="none">
                <ConnectedServicesConnectMore
                    model={model}
                    layout="firstRun"
                    request={null}
                    onRequestHandled={noop}
                    onConnected={noop}
                    renderServiceFlow={renderFixtureFlow}
                    targetSelection={FIXTURE_SELECTION}
                />
            </ItemGroup>
            <ProviderUsageGaugeSettingsGroup settings={CONNECTED_SERVICES_USAGE_GAUGE_SETTINGS.settings} />
        </ItemList>
    );
}

/** AS: each sign-in kind in the states the controller produces (drawn by the real forms). */
function SetupStatesFrame() {
    const now = Date.now();
    return (
        <ItemList>
            <PageHeader title="Setup states" description="With a code (ChatGPT), browser + code (Claude), key (Anthropic): waiting and expired." />
            <ItemGroup title={t('connectedServicesSettings.modeDeviceCode')} surface="none">
                <View style={styles.cells}>
                    <View style={styles.cell}>
                        <ConnectedAccountDeviceForm embedded verificationUri="https://chatgpt.com/device" userCode="WDJB-MJHT" expiresAtMs={now + 14 * MIN} serviceTitle="ChatGPT" busy={false} onPoll={noop} onResume={noop} />
                    </View>
                    <View style={styles.cell}>
                        <ConnectedAccountDeviceForm embedded verificationUri="https://chatgpt.com/device" userCode="WDJB-MJHT" expiresAtMs={now - 1000} serviceTitle="ChatGPT" busy={false} onPoll={noop} onResume={noop} />
                    </View>
                </View>
            </ItemGroup>
            <ItemGroup title={t('connectedServicesSettings.modeBrowser')} surface="none">
                <View style={styles.cells}>
                    <View style={styles.cell}>
                        <ConnectedAccountOAuthForm embedded authorizationUrl="https://claude.ai/oauth/authorize" callbackUrl="https://platform.claude.com/oauth/code/callback" submitting={false} onSubmit={noop} />
                    </View>
                    <View style={styles.cell}>
                        <ConnectedAccountOAuthForm embedded authorizationUrl="https://claude.ai/oauth/authorize" callbackUrl="https://platform.claude.com/oauth/code/callback" submitting onSubmit={noop} />
                    </View>
                </View>
            </ItemGroup>
            <ItemGroup title={t('connectedServicesSettings.modeManual')} surface="none">
                <View style={styles.cell}>
                    <ConnectedAccountManualForm embedded title="Anthropic API key" fields={[{ id: 'token', title: 'Anthropic API key', secret: true, schema: { type: 'string', minLength: 1 } }] as never} submitting={false} onSubmit={noop} />
                </View>
            </ItemGroup>
        </ItemList>
    );
}

/** H2 / H2c / H2b: Home's Get set up with the connected-services block (rest, open, after connecting). */
function HomeFrame(props: Readonly<{ stage: 'rest' | 'open' | 'after' }>) {
    const phone = useDeviceType() === 'phone';
    const after = props.stage === 'after';
    const model = useModel({ accounts: after });
    const catalog = React.useMemo(() => buildConnectedServiceSetupCatalog(model), [model]);
    const [target, setTarget] = React.useState<ConnectedServiceSetupTarget | null>(null);
    // Before any account the subscriptions are offered (the fixture's Claude and ChatGPT have none yet);
    // after, the next service an agent accepts (Gemini).
    const offer = selectHomeConnectInvitations({
        connectable: model.connectable.filter((service) => service.service === CLAUDE || service.service === CHATGPT || service.service === GEMINI),
        hidden: new Set(),
        hasAccounts: after,
    });
    const services = buildConnectServicesSetupItem({ offer, catalog, layout: phone ? 'row' : 'card', target, setTarget, dismiss: noop, renderServiceFlow: renderFixtureFlow, targetSelection: FIXTURE_SELECTION });
    const tile = (id: string, icon: 'device-mobile' | 'desktop', title: string, subtitle: string, label: string): SetupBlockItem => ({
        id,
        renderTile: () => (
            <SetupBlockTile
                testID={`dev-setup.${id}`}
                layout={phone ? 'row' : 'card'}
                icon={icon}
                title={title}
                subtitle={subtitle}
                action={{ label, testID: `dev-setup.${id}.action`, onPress: noop }}
                dismiss={{ label: title, tooltip: t('homeSetup.dismissTooltip'), onPress: noop }}
            />
        ),
    });
    const items: SetupBlockItem[] = [
        tile('addPhone', 'device-mobile', t('settings.addYourPhone'), t('settings.addYourPhoneSubtitle'), t('settingsOverview.setupActionShowQr')),
        ...(after || phone ? [] : [tile('addMachine', 'desktop', t('settingsOverview.addMachineTitle'), t('settingsOverview.addMachineSubtitle'), t('settingsOverview.setupActionAddMachine'))]),
        ...(services ? [services] : []),
    ];
    return (
        <ItemList>
            <ItemGroup title={t('settingsOverview.setupTitle')} surface="none">
                <SetupBlockGrid
                    testID="hub-setup.grid"
                    items={items}
                    columns={phone ? 1 : 3}
                    openId={props.stage === 'open' ? services?.id ?? null : null}
                    onOpenChange={noop}
                />
            </ItemGroup>
            {after ? <ItemGroup title={t('settingsOverview.usageTitle')} surface="none"><HubUsageCardGrid entries={HOME_USAGE} /></ItemGroup> : null}
        </ItemList>
    );
}

const HOME_USAGE = [
    { key: 'claude/work', serviceLabel: 'Claude', legacyServiceId: 'claude-subscription', profileLabel: 'Work', planLabel: 'Max', meters: [{ meterId: '5h', label: '5-hour', remainingPct: 42, resetsAt: Date.now() + 2 * HOUR }, { meterId: 'wk', label: 'Weekly', remainingPct: 64, resetsAt: Date.now() + 4 * DAY }] },
    { key: 'codex/personal', serviceLabel: 'ChatGPT', legacyServiceId: 'openai-codex', profileLabel: 'Personal', planLabel: 'Pro', meters: [{ meterId: '5h', label: '5-hour', remainingPct: 71, resetsAt: Date.now() + 3 * HOUR }, { meterId: 'wk', label: 'Weekly', remainingPct: 22, resetsAt: Date.now() + 2 * DAY }] },
].map((entry) => ({ ...entry, fetchedAt: Date.now() - 12 * MIN }));

const styles = StyleSheet.create(() => ({
    cells: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 16,
    },
    cell: {
        flexGrow: 1,
        flexBasis: 320,
        minWidth: 0,
    },
}));

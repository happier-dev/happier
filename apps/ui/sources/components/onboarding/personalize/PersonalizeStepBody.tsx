import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { isPushNotificationRuntimeSupported, readPushPermission } from '@/activity/notifications/permission/pushNotificationAccess';
import { runPushNotificationPermissionPriming } from '@/activity/notifications/permission/pushNotificationPermissionPriming';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { APPEARANCE_SETTINGS } from '@/components/settings/appearance/appearanceSettings';
import { GlassEffectiveStateLine, GlassPresetPreview } from '@/components/settings/appearance/GlassAppearanceControls';
import { ThemeModePreview } from '@/components/settings/appearance/ThemeModePreview';
import { buildSettingHref } from '@/components/settings/catalog/settingDeclarations';
import { useTauriNotificationPermissionDiagnostics } from '@/components/settings/notifications/useTauriNotificationPermissionDiagnostics';
import { SessionListDensityPreview, SessionListLayoutPreview, SessionListSample } from '@/components/settings/session/SessionListPreview';
import { ToolStylePreview, TranscriptLayoutPreview } from '@/components/settings/session/SessionSettingPreviews';
import { THINKING_DISPLAY_CHOICES } from '@/components/settings/session/thinkingDisplayChoice';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Switch } from '@/components/ui/forms/Switch';
import { resolveGlassPresetSettingsDelta, type GlassPreset } from '@/components/ui/glass/glassMaterial';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { SESSION_LIST_LAYOUT_CHOICES } from '@/sync/domains/session/listing/sessionListLayout';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { desktopHostKind } from '@/utils/platform/desktopHost';

import { buildPersonalizeListSample, PersonalizeStage } from './PersonalizeStage';
import {
    PERSONALIZE_STEPS,
    STARTING_STYLES,
    applyStartingStyle,
    listStartingStyleChanges,
    matchStartingStyle,
    type AttentionPlacementChoice,
    type PersonalizeChoices,
    type PersonalizeStepId,
    type StartingStyleId,
} from './personalizeFlowModel';
import {
    describePersonalizeStep,
    personalizeLabels,
    personalizeStepName,
    personalizeStepScope,
    personalizeStyleFieldLabel,
    personalizeStyleFieldValue,
} from './personalizeLabels';
import type { PersonalizeFlow } from './usePersonalizeFlow';

const GLASS_PRESETS: readonly GlassPreset[] = ['solid', 'auto', 'everywhere'];
const ATTENTION_CHOICES: readonly AttentionPlacementChoice[] = ['off', 'withinGroups', 'global'];

/** A choice's section: its label, where the choice applies, and what it means. */
function ChoiceSection(props: Readonly<{
    title: string;
    scope: 'device' | 'account';
    description?: string;
    tiles?: boolean;
    children: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    return (
        <ItemGroup
            title={props.title}
            description={props.description}
            surface={props.tiles ? 'none' : undefined}
            action={(
                <View style={styles.scope}>
                    <Icon name={props.scope === 'device' ? 'desktop' : 'globe'} size={14} color={theme.colors.text.tertiary} />
                    <Text style={styles.scopeLabel}>
                        {props.scope === 'device' ? t('personalize.scopeThisDevice') : t('personalize.scopeAllDevices')}
                    </Text>
                </View>
            )}
        >
            {props.children}
        </ItemGroup>
    );
}

function Note(props: Readonly<{ icon: IconName; children: string; testID?: string }>) {
    const { theme } = useUnistyles();
    return (
        <View testID={props.testID} style={styles.note}>
            <Icon name={props.icon} size={16} color={theme.colors.text.tertiary} />
            <Text style={styles.noteText}>{props.children}</Text>
        </View>
    );
}

/** The controls of one Personalize page. Every preview renders real components at static props. */
export function PersonalizeStepBody(props: Readonly<{ flow: PersonalizeFlow; phone: boolean; testID: string }>) {
    return <ListPresentationProvider value="page" pageInsets="contained">{renderStepBody(props)}</ListPresentationProvider>;
}

function renderStepBody(props: Readonly<{ flow: PersonalizeFlow; phone: boolean; testID: string }>) {
    const { flow } = props;
    switch (flow.page) {
        case 'look': return <LookStep flow={flow} testID={props.testID} />;
        case 'style': return <StyleStep flow={flow} phone={props.phone} testID={props.testID} />;
        case 'conversation': return <ConversationStep flow={flow} testID={props.testID} />;
        case 'tools': return <ToolsStep flow={flow} testID={props.testID} />;
        case 'work': return <WorkStep flow={flow} testID={props.testID} />;
        case 'attention': return <AttentionStep flow={flow} testID={props.testID} />;
        case 'notifications': return <NotificationsStep flow={flow} testID={props.testID} />;
        case 'summary': return <SummaryStep flow={flow} testID={props.testID} />;
    }
}

/** Theme and material: the controls the Home card opens in place and the page's first step share. */
export function LookChoices(props: Readonly<{ flow: Pick<PersonalizeFlow, 'draft' | 'selectTheme' | 'update'>; testID: string }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { draft } = props.flow;
    return (
        <>
            <ChoiceSection
                title={t('personalize.themeLabel')}
                scope="device"
                tiles
            >
                <SelectionTiles
                    variant="visual"
                    tileSizing="fill"
                    accessibilityLabel={t('personalize.themeLabel')}
                    testIdPrefix={`${props.testID}-theme`}
                    value={draft.theme}
                    onChange={(next) => { if (next) props.flow.selectTheme(next); }}
                    options={(['adaptive', 'light', 'dark'] as const).map((mode) => ({
                        id: mode,
                        title: personalizeLabels.theme(mode),
                        preview: <ThemeModePreview mode={mode} />,
                    }))}
                />
            </ChoiceSection>
            <ChoiceSection title={t('personalize.glassLabel')} scope="account" tiles
                description={draft.glass === 'custom' ? t('personalize.glassCustomNote') : undefined}
            >
                <SelectionTiles
                    variant="visual"
                    tileSizing="fill"
                    accessibilityLabel={t('personalize.glassLabel')}
                    testIdPrefix={`${props.testID}-glass`}
                    value={draft.glass === 'custom' ? null : draft.glass}
                    onChange={(next) => { if (next) props.flow.update({ glass: next }); }}
                    options={GLASS_PRESETS.map((preset) => ({
                        id: preset,
                        title: personalizeLabels.glass(preset),
                        preview: <GlassPresetPreview preset={preset} settings={draft.glassSettings} palette={theme} />,
                    }))}
                />
                <GlassEffectiveStateLine inset="none" settings={draft.glass === 'custom' ? draft.glassSettings
                    : { ...draft.glassSettings, ...resolveGlassPresetSettingsDelta(draft.glassSettings, draft.glass) }} />
                <View style={styles.inlineAction}>
                    <RoundButton
                        testID={`${props.testID}-customize-glass`}
                        size="small"
                        display="inverted"
                        title={t('personalize.customizeInAppearance')}
                        onPress={() => router.push(buildSettingHref('/settings/appearance', APPEARANCE_SETTINGS.settings.glassCustomize) as never)}
                    />
                </View>
            </ChoiceSection>
        </>
    );
}

function LookStep(props: Readonly<{ flow: PersonalizeFlow; testID: string }>) {
    return <LookChoices flow={props.flow} testID={props.testID} />;
}

/** The one starting-style chooser, placed on the desktop stage or in the phone's scroll. */
export function PersonalizeStyleChoices(props: Readonly<{ flow: PersonalizeFlow; phone: boolean; testID: string }>) {
    const { flow } = props;
    const current = flow.draft;
    const matched = matchStartingStyle(current);
    const selected = flow.style;
    const options: Array<{ id: StartingStyleId | 'keep'; title: string; badge?: string; choices: PersonalizeChoices }> = [
        { id: 'keep', title: t('personalize.styleKeep'), badge: matched ? personalizeLabels.style(matched) : t('personalize.styleCustomTag'), choices: current },
        ...STARTING_STYLES.map((style) => ({
            id: style,
            title: personalizeLabels.style(style),
            ...(style === 'activity' ? { badge: t('personalize.styleDefaultTag') } : {}),
            choices: applyStartingStyle(current, style),
        })),
    ];
    return (
        <SelectionTiles<StartingStyleId | 'keep'>
            variant={props.phone ? 'card' : 'visual'}
            density={props.phone ? 'compact' : undefined}
            tileSizing="fill"
            maximumColumns={props.phone ? 1 : 2}
            accessibilityLabel={t('personalize.styleTitle')}
            testIdPrefix={`${props.testID}-style`}
            value={selected}
            onChange={(next) => { if (next) flow.setStyle(next); }}
            options={options.map((option) => ({
                id: option.id,
                title: option.title,
                ...(option.badge ? { badge: option.badge } : {}),
                subtitle: [
                    personalizeLabels.transcriptLayout(option.choices.transcriptLayout),
                    personalizeLabels.toolChrome(option.choices.toolChrome),
                    personalizeLabels.listDensity(option.choices.listDensity),
                ].join(' · '),
                preview: props.phone ? <ToolStylePreview style={option.choices.toolChrome} /> : <StageMiniature choices={option.choices} />,
            }))}
        />
    );
}

function StyleStep(props: Readonly<{ flow: PersonalizeFlow; phone: boolean; testID: string }>) {
    const { flow } = props;
    const selected = flow.style;
    const matched = matchStartingStyle(flow.draft);
    const changes = selected === 'keep' ? [] : listStartingStyleChanges(flow.draft, selected);
    return (
        <>
            {props.phone ? (
                <ItemGroup title={t('personalize.styleTitle')} surface="none">
                    <PersonalizeStyleChoices {...props} />
                </ItemGroup>
            ) : selected === 'keep' ? (
                <ItemGroup title={t('personalize.styleKeep')} description={matched ? personalizeLabels.style(matched) : t('personalize.styleCustomTag')}>{null}</ItemGroup>
            ) : null}
            {selected !== 'keep' ? (
                <ItemGroup
                    title={t('personalize.styleChanges', { style: personalizeLabels.style(selected), count: changes.length })}
                    description={changes.length === 0 ? t('personalize.styleNoChanges') : undefined}
                >
                    {changes.map((change) => (
                        <Item
                            key={change.field}
                            testID={`${props.testID}-style-change-${change.field}`}
                            title={personalizeStyleFieldLabel(change.field)}
                            detail={`${personalizeStyleFieldValue(change.field, change.to)} · ${t('personalize.was', { value: personalizeStyleFieldValue(change.field, change.from) })}`}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ) : null}
            <Note icon="lock">{t('personalize.styleNever')}</Note>
        </>
    );
}

/** The stage at a fixed canvas, scaled into a tile: the same composition as the live stage. */
function StageMiniature(props: Readonly<{ choices: PersonalizeChoices }>) {
    const [width, setWidth] = React.useState(0);
    return (
        <View style={styles.miniatureViewport} pointerEvents="none" onLayout={(event) => {
            const measured = event.nativeEvent.layout.width;
            if (measured > 0) setWidth(measured);
        }}>
            <View style={[styles.miniatureCanvas, { transform: [{ scale: width / STAGE_CANVAS.width }] }]}>
                <PersonalizeStage draft={props.choices} focus="none" presentation="miniature" />
            </View>
        </View>
    );
}

function ConversationStep(props: Readonly<{ flow: PersonalizeFlow; testID: string }>) {
    const { flow } = props;
    return (
        <>
            <ChoiceSection title={t('personalize.layoutLabel')} scope="account" tiles>
                <SelectionTiles
                    variant="visual"
                    tileSizing="fill"
                    accessibilityLabel={t('personalize.layoutLabel')}
                    testIdPrefix={`${props.testID}-layout`}
                    value={flow.draft.transcriptLayout}
                    onChange={(next) => { if (next) flow.update({ transcriptLayout: next }); }}
                    options={(['turns', 'linear'] as const).map((layout) => ({
                        id: layout,
                        title: personalizeLabels.transcriptLayout(layout),
                        preview: <TranscriptLayoutPreview layout={layout} />,
                    }))}
                />
            </ChoiceSection>
            <ItemGroup>
                <SegmentedChoiceItem
                    testID={`${props.testID}-thinking`}
                    testIDPrefix={`${props.testID}-thinking`}
                    title={t('personalize.thinkingLabel')}
                    value={flow.draft.thinking}
                    onChange={(thinking) => flow.update({ thinking })}
                    options={THINKING_DISPLAY_CHOICES.map((choice) => ({ id: choice, label: personalizeLabels.thinking(choice) }))}
                />
            </ItemGroup>
        </>
    );
}

function ToolsStep(props: Readonly<{ flow: PersonalizeFlow; testID: string }>) {
    const { flow } = props;
    const detailShown = flow.draft.toolDetail === 'default' || flow.draft.toolDetail === 'full';
    return (
        <>
            <ChoiceSection title={t('personalize.toolsLabel')} scope="account" tiles>
                <SelectionTiles
                    variant="visual"
                    tileSizing="fill"
                    accessibilityLabel={t('personalize.toolsLabel')}
                    testIdPrefix={`${props.testID}-tools`}
                    value={flow.draft.toolChrome}
                    onChange={(next) => { if (next) flow.update({ toolChrome: next }); }}
                    options={(['activity_feed', 'cards'] as const).map((style) => ({
                        id: style,
                        title: personalizeLabels.toolChrome(style),
                        preview: <ToolStylePreview style={style} />,
                    }))}
                />
            </ChoiceSection>
            <ItemGroup>
                <SegmentedChoiceItem
                    testID={`${props.testID}-tap`}
                    testIDPrefix={`${props.testID}-tap`}
                    title={t('personalize.toolTapLabel')}
                    value={flow.draft.toolTap}
                    onChange={(toolTap) => flow.update({ toolTap })}
                    options={(['expand', 'open'] as const).map((tap) => ({ id: tap, label: personalizeLabels.toolTap(tap) }))}
                />
                {detailShown ? (
                    <SegmentedChoiceItem<'default' | 'full'>
                        testID={`${props.testID}-detail`}
                        testIDPrefix={`${props.testID}-detail`}
                        title={t('personalize.toolDetailLabel')}
                        value={flow.draft.toolDetail === 'full' ? 'full' : 'default'}
                        onChange={(toolDetail) => flow.update({ toolDetail })}
                        options={(['default', 'full'] as const).map((detail) => ({ id: detail, label: personalizeLabels.toolDetail(detail) }))}
                    />
                ) : null}
            </ItemGroup>
        </>
    );
}

function WorkStep(props: Readonly<{ flow: PersonalizeFlow; testID: string }>) {
    const { flow } = props;
    return (
        <>
            <ChoiceSection title={t('personalize.listLayoutLabel')} scope="account" tiles>
                <SelectionTiles
                    variant="visual"
                    tileSizing="fill"
                    accessibilityLabel={t('personalize.listLayoutLabel')}
                    testIdPrefix={`${props.testID}-list-layout`}
                    value={flow.draft.listLayout}
                    onChange={(next) => { if (next) flow.update({ listLayout: next }); }}
                    options={SESSION_LIST_LAYOUT_CHOICES.map((layout) => ({
                        id: layout,
                        title: personalizeLabels.listLayout(layout),
                        preview: <SessionListLayoutPreview layout={`layout:${layout}`} />,
                    }))}
                />
            </ChoiceSection>
            <ChoiceSection title={t('personalize.rowsLabel')} scope="account" tiles>
                <SelectionTiles
                    variant="visual"
                    tileSizing="fill"
                    accessibilityLabel={t('personalize.rowsLabel')}
                    testIdPrefix={`${props.testID}-rows`}
                    value={flow.draft.listDensity}
                    onChange={(next) => { if (next) flow.update({ listDensity: next }); }}
                    options={(['detailed', 'cozy', 'narrow'] as const).map((density) => ({
                        id: density,
                        title: personalizeLabels.listDensity(density),
                        preview: <SessionListDensityPreview density={density} />,
                    }))}
                />
            </ChoiceSection>
        </>
    );
}

function AttentionStep(props: Readonly<{ flow: PersonalizeFlow; testID: string }>) {
    const { flow } = props;
    return (
        <>
            <ChoiceSection title={t('personalize.attentionLabel')} scope="account" tiles>
                <SelectionTiles
                    variant="visual"
                    tileSizing="fill"
                    accessibilityLabel={t('personalize.attentionLabel')}
                    testIdPrefix={`${props.testID}-attention`}
                    value={flow.draft.attention}
                    onChange={(next) => { if (next) flow.update({ attention: next }); }}
                    options={ATTENTION_CHOICES.map((placement) => ({
                        id: placement,
                        title: personalizeLabels.attention(placement),
                        preview: (
                            <View style={styles.listMiniatureViewport} pointerEvents="none">
                                <View style={styles.listMiniatureCanvas}>
                                    <SessionListSample density="narrow" groups={buildPersonalizeListSample(flow.draft.listLayout, placement)} width={280} />
                                </View>
                            </View>
                        ),
                    }))}
                />
            </ChoiceSection>
            <Note icon="house">{t('personalize.attentionHomeNote')}</Note>
        </>
    );
}

type DeviceNotificationPermission = Readonly<{
    status: 'checking' | 'granted' | 'notGranted' | 'unsupported';
    /** Asks the OS, framed in-app first. Only ever called from the explicit Allow button. */
    request: () => Promise<void>;
}>;

/** This device's OS notification permission, from the owner each host already uses. */
function useDeviceNotificationPermission(): DeviceNotificationPermission {
    const tauri = Platform.OS === 'web' && desktopHostKind() === 'tauri';
    const desktop = useTauriNotificationPermissionDiagnostics(tauri);
    const native = isPushNotificationRuntimeSupported();
    const [nativeStatus, setNativeStatus] = React.useState<DeviceNotificationPermission['status']>(native ? 'checking' : 'unsupported');
    React.useEffect(() => {
        if (!native) return;
        let cancelled = false;
        void readPushPermission().then((outcome) => {
            if (cancelled) return;
            setNativeStatus(!outcome.ok || outcome.permission.status === 'unsupported' ? 'unsupported'
                : outcome.permission.granted ? 'granted' : 'notGranted');
        });
        return () => { cancelled = true; };
    }, [native]);
    const requestNative = React.useCallback(async () => {
        const outcome = await runPushNotificationPermissionPriming({
            pushEnabled: true,
            trigger: 'user_action',
            onGranted: () => sync.onPushPermissionGranted(),
        });
        setNativeStatus(outcome.granted ? 'granted' : 'notGranted');
    }, []);
    if (tauri) {
        return {
            status: desktop.status === 'error' ? 'notGranted' : desktop.status,
            request: desktop.requestPermission,
        };
    }
    return { status: nativeStatus, request: requestNative };
}

function NotificationsStep(props: Readonly<{ flow: PersonalizeFlow; testID: string }>) {
    const { theme } = useUnistyles();
    const { flow } = props;
    const permission = useDeviceNotificationPermission();
    if (permission.status === 'unsupported') {
        return <Note testID={`${props.testID}-permission`} icon="device-mobile">{t('personalize.notificationsUnsupported')}</Note>;
    }
    return (
        <>
            {permission.status === 'granted' || permission.status === 'notGranted' ? (
                <View testID={`${props.testID}-permission`} style={styles.permission}>
                    <Icon
                        name={permission.status === 'granted' ? 'check' : 'bell'}
                        size={16}
                        color={permission.status === 'granted' ? theme.colors.state.success.foreground : theme.colors.text.secondary}
                    />
                    <Text style={styles.permissionText}>
                        {permission.status === 'granted' ? t('personalize.notificationsAllowed') : t('personalize.notificationsNotAllowed')}
                    </Text>
                    {permission.status === 'notGranted' ? (
                        <RoundButton
                            testID={`${props.testID}-allow`}
                            size="small"
                            display="secondary"
                            title={t('personalize.notificationsAllow')}
                            onPress={() => { void permission.request(); }}
                        />
                    ) : null}
                </View>
            ) : null}
            <ChoiceSection title={t('personalize.notificationsTellMe')} scope="device">
                <Item
                    testID={`${props.testID}-needs-you`}
                    title={t('personalize.notificationsNeedsYou')}
                    showChevron={false}
                    onPress={() => flow.update({ notifyNeedsYou: !flow.draft.notifyNeedsYou })}
                    rightElement={<Switch value={flow.draft.notifyNeedsYou} onValueChange={(notifyNeedsYou) => flow.update({ notifyNeedsYou })} />}
                />
                <Item
                    testID={`${props.testID}-finished`}
                    title={t('personalize.notificationsFinished')}
                    showChevron={false}
                    onPress={() => flow.update({ notifyFinished: !flow.draft.notifyFinished })}
                    rightElement={<Switch value={flow.draft.notifyFinished} onValueChange={(notifyFinished) => flow.update({ notifyFinished })} />}
                />
            </ChoiceSection>
            <ItemGroup>
                <SegmentedChoiceItem<'message' | 'status'>
                    testID={`${props.testID}-preview`}
                    testIDPrefix={`${props.testID}-preview`}
                    title={t('personalize.notificationsShowLabel')}
                    subtitle={t('personalize.notificationsShowDescription')}
                    subtitleLines={0}
                    value={flow.draft.notifyPreview ? 'message' : 'status'}
                    onChange={(next) => flow.update({ notifyPreview: next === 'message' })}
                    options={[
                        { id: 'message', label: t('personalize.notificationsMessage') },
                        { id: 'status', label: t('personalize.notificationsStatus') },
                    ]}
                />
            </ItemGroup>
            {Platform.OS === 'web' ? <Note icon="device-mobile">{t('personalize.notificationsPhoneNote')}</Note> : null}
        </>
    );
}

function SummaryStep(props: Readonly<{ flow: PersonalizeFlow; testID: string }>) {
    const { flow } = props;
    const permission = useDeviceNotificationPermission();
    return (
        <>
            <ItemGroup>
                {PERSONALIZE_STEPS.map((step: PersonalizeStepId) => {
                    const unsupported = step === 'notifications' && permission.status === 'unsupported';
                    const now = unsupported ? t('personalize.notificationsUnsupported') : describePersonalizeStep(step, flow.draft);
                    const was = describePersonalizeStep(step, flow.openedWith);
                    return (
                        <Item
                            key={step}
                            testID={`${props.testID}-summary-${step}`}
                            title={unsupported ? personalizeStepName(step) : now}
                            titleLines={0}
                            subtitle={unsupported ? now : `${personalizeStepName(step)} · ${personalizeStepScope(step)}${now !== was ? ` · ${t('personalize.was', { value: was })}` : ''}`}
                            subtitleLines={0}
                            showChevron={false}
                            rightElement={unsupported ? undefined : (
                                <RoundButton
                                    testID={`${props.testID}-summary-${step}-change`}
                                    size="small"
                                    display="inverted"
                                    title={t('personalize.summaryChange')}
                                    onPress={() => flow.open(step)}
                                />
                            )}
                            rightElementOutsidePressable
                        />
                    );
                })}
            </ItemGroup>
        </>
    );
}

/** How many of the six steps differ from what the visit found, for the summary's sentence. */
export function countPersonalizeChanges(flow: Pick<PersonalizeFlow, 'draft' | 'openedWith'>): number {
    return PERSONALIZE_STEPS.filter((step) => describePersonalizeStep(step, flow.draft) !== describePersonalizeStep(step, flow.openedWith)).length;
}

const STAGE_CANVAS = { width: 900, height: 520 } as const;

const styles = StyleSheet.create((theme) => ({
    scope: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    scopeLabel: {
        color: theme.colors.text.tertiary,
        fontSize: 13,
        lineHeight: 18,
    },
    note: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        paddingHorizontal: 4,
    },
    noteText: {
        flex: 1,
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
    inlineAction: {
        flexDirection: 'row',
        paddingTop: 10,
    },
    miniatureViewport: {
        flex: 1,
        overflow: 'hidden',
    },
    miniatureCanvas: {
        width: STAGE_CANVAS.width,
        height: STAGE_CANVAS.height,
        transformOrigin: 'top left',
    },
    listMiniatureViewport: {
        flex: 1,
        overflow: 'hidden',
    },
    listMiniatureCanvas: {
        width: 280,
        transform: [{ scale: 0.5 }],
        transformOrigin: 'top left',
        paddingTop: 8,
    },
    permission: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 12,
        borderCurve: 'continuous',
        backgroundColor: theme.colors.surface.inset,
    },
    permissionText: {
        flex: 1,
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 19,
    },
}));

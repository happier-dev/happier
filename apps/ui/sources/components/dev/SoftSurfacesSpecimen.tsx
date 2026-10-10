import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { ScopedTheme, StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles';

import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { ItemList } from '@/components/ui/lists/ItemList';
import { AppShellMaterialFrame } from '@/components/navigation/shell/AppShellMaterialFrame';
import { FileActionToolbar } from '@/components/workspaces/files/file/FileActionToolbar';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Popover } from '@/components/ui/popover/Popover';
import { GlassMaterialRuntime } from '@/components/ui/glass/GlassMaterialRuntime';
import { GlassMaterialSettingsProvider } from '@/components/ui/glass/useGlassMaterialSettings';
import { glassPresetMaterials, type GlassMaterialSettings } from '@/components/ui/glass/glassMaterial';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { AgentInput } from '@/components/sessions/agentInput/AgentInput';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { applyThemeStyleScales, resolveThemeStyleScales } from '@/theme/themeStyleScales';

const noop = () => {};
const noSuggestions = async () => [];
const ROWS = ['Retry relay handshake', 'Review the settings modal', 'Craft pass lab'] as const;
const FINISH_ROLES = ['card', 'floating', 'composer', 'primaryButton', 'secondaryButton'] as const;

/** Public dev specimen outside authenticated runtimes: real owners and inert fixture controls. */
export default function SoftSurfacesSpecimen() {
    const params = useLocalSearchParams<{ theme?: string; finish?: string; glass?: string; frame?: string; role?: string; roleFinish?: string; preset?: string; inputAudit?: string }>();
    const theme = params.theme === 'dark' ? 'dark' : 'light';
    const finish = params.finish === 'flat' ? 'flat' : 'soft';
    const role = FINISH_ROLES.find(candidate => candidate === params.role);
    const roleFinish = params.roleFinish === 'flat' ? 'flat' : 'soft';
    const glass = params.glass === 'full' ? 'full' : params.glass === 'content' ? 'content' : 'off';
    const frame = params.frame === 'home' || params.frame === 'settings' || params.frame === 'glass' || params.frame === 'audit' || params.frame === 'shell' ? params.frame : 'roles';
    const [ready, setReady] = React.useState(false);
    React.useLayoutEffect(() => {
        const previous = UnistylesRuntime.getTheme(theme);
        UnistylesRuntime.updateTheme(theme, current => applyThemeStyleScales(current, resolveThemeStyleScales({ finish,
            parts: role ? { [role]: { finish: roleFinish } } : undefined })));
        setReady(true);
        return () => UnistylesRuntime.updateTheme(theme, () => previous);
    }, [theme, finish, role, roleFinish]);
    const material = React.useMemo<GlassMaterialSettings>(() => {
        if (params.preset === 'auto' || params.preset === 'everywhere' || params.preset === 'solid' || params.preset === 'clear') return {
            glassBlurEnabled: params.preset !== 'solid', glassBlurIntensity: params.preset === 'clear' ? 'strong' : 'regular',
            glassSurfaceMaterials: glassPresetMaterials(params.preset, params.preset === 'clear' ? 'strong' : 'regular'),
        };
        const solid = glassPresetMaterials('solid');
        const all = glassPresetMaterials('everywhere');
        return {
            glassBlurEnabled: glass !== 'off',
            glassSurfaceMaterials: glass === 'full' ? all : glass === 'content' ? { ...solid, content: all.content } : solid,
        };
    }, [glass, params.preset]);
    if (!ready) return null;
    return <ScopedTheme name={theme}>
        <GlassMaterialSettingsProvider value={material}>
            <GlassMaterialRuntime>
                <View style={styles.stage} testID="soft-surfaces-specimen">
                    <View pointerEvents="none" style={[styles.backdrop, glass === 'off' ? { opacity: 0 } : null]}>
                        <View style={styles.backdropBand} />
                        <View style={styles.backdropAccent} />
                        {params.preset ? Array.from({ length: 32 }, (_, index) => <View key={index} style={[styles.backdropDetail, { top: index * 34 }]} />) : null}
                    </View>
                    <ScrollView contentContainerStyle={styles.page}>
                        <Basis themeName={theme} finish={finish} glass={glass} />
                        {frame === 'home' ? <Home /> : frame === 'settings' ? <Settings /> : frame === 'glass' ? <Glass /> : frame === 'audit' ? <Audit inputAudit={params.inputAudit === '1'} /> : frame === 'shell' ? <Shell /> : <Roles />}
                    </ScrollView>
                </View>
            </GlassMaterialRuntime>
        </GlassMaterialSettingsProvider>
    </ScopedTheme>;
}

function Basis(props: Readonly<{ themeName: string; finish: string; glass: string }>) {
    const { theme } = useUnistyles();
    return <Text testID="soft-surfaces-basis" style={styles.basis}>Soft surfaces specimen · v3 · {props.themeName} · {props.finish} · {props.glass} · effective={theme.finish} · dark={String(theme.dark)} · color={theme.colors.edge.cardFill} · base={theme.colors.surface.base} · sheet={theme.colors.surface.sectionTint} · roles={JSON.stringify(Object.fromEntries(FINISH_ROLES.map(role => [role, theme.parts[role].finish])))}</Text>;
}

function Widget(props: Readonly<{ title: string; id: string }>) {
    return <WidgetFrame testID={`soft-widget-${props.id}`} frameStyle="card" placement="home" title={props.title} mark="git-pull-request"
        source="PRs & Issues" meta={<Text style={styles.bodyText}>3 new</Text>} body={{ kind: 'content', children: <View>{ROWS.map((row, index) =>
            <Item key={row} title={row} detail={index === 0 ? '2m' : '1h'} showChevron={false} />)}</View> }} />;
}

function Buttons() {
    return <View style={styles.buttons}>
        <RoundButton title="Add widget" onPress={noop} size="normal" testID="soft-primary-button" />
        <RoundButton title="Cancel" onPress={noop} size="normal" display="secondary" testID="soft-secondary-button" />
        <RoundButton title="Delete…" onPress={noop} size="normal" display="destructive" testID="soft-destructive-button" />
    </View>;
}

function Composer() {
    return <View testID="soft-composer"><AgentInput value="Review the settings modal and its keyboard behavior." placeholder="Message this session…"
        autocompleteKinds={[]} autocompleteSuggestions={noSuggestions} engineControls="none" voiceAffordance="none" messageHistory="none" /></View>;
}

function Home() {
    return <ListPresentationProvider value="grouped">
        <PageHeader title="Home" description="Real widget frames and the session composer at fixture data." />
        <Composer />
        <View style={styles.grid}><View style={styles.column}><Widget title="New for you" id="new" /><Widget title="Usage today" id="usage" /></View>
            <View style={styles.column}><Widget title="Running" id="running" /><Widget title="Projects" id="projects" /></View></View>
        <Buttons />
    </ListPresentationProvider>;
}

function Settings() {
    return <ListPresentationProvider value="page">
        <PageHeader title="Appearance" description="Real settings sheets and controls with inert callbacks." />
        <ItemGroup title="Alerts" description="When an agent needs you">
            <Item title="Push notifications" subtitle="On this device" detail="On" showChevron={false} />
            <Item title="Sound" detail="Chime" showChevron={false} />
            <Item title="Quiet hours" detail="22:00–07:00" showChevron={false} />
        </ItemGroup>
        <ItemGroup title="Surface finish" description="The same card role frames widgets.">
            <Item title="Finish" detail="Selected through this specimen’s URL" showChevron={false} />
            <Widget title="New for you" id="settings" />
        </ItemGroup>
        <Buttons />
    </ListPresentationProvider>;
}

function Roles() {
    return <ListPresentationProvider value="grouped">
        <PageHeader title="Soft surfaces" description="Real cards, sheets, floating chrome, composer and buttons." />
        <Tooltip testID="soft-tooltip-trigger" label="A real floating tooltip"><Text style={styles.muted}>Hover or focus for surface help</Text></Tooltip>
        <View style={styles.grid}>
            <View style={styles.column}><Widget title="New for you" id="roles" />
                <SurfaceCard testID="soft-surface-card"><Text style={styles.bodyText}>Surface card</Text><Text style={styles.muted}>The existing fill beneath one ink overlay.</Text></SurfaceCard>
                <ItemGroup title="Settings sheet"><Item title="Notifications" detail="On" showChevron={false} /><Item title="Sound" detail="Chime" showChevron={false} /></ItemGroup>
            </View>
            <View style={styles.column}>
                <View testID="soft-menu"><FloatingOverlay scrollEnabled={false} edgeFades={false}>
                    <ItemGroup header="none" surface="none"><Item title="Duplicate" onPress={noop} /><Item title="Edit inputs" onPress={noop} /><Item title="Remove" onPress={noop} destructive /></ItemGroup>
                </FloatingOverlay></View>
                <ModalCardFrame testID="soft-dialog" title="Remove “New for you”?" subtitle="You can add it again." size="dialog" bodyScroll="none"
                    footer={<Buttons />}><Text style={styles.bodyText}>It leaves this preview only.</Text></ModalCardFrame>
            </View>
        </View>
        <Composer />
        <Buttons />
    </ListPresentationProvider>;
}

function Glass() {
    return <ListPresentationProvider value="grouped">
        <PageHeader title="Glass surfaces" description="The backdrop remains visible through the same ink overlay." />
        <View style={styles.grid}>{(['chrome', 'sidebar', 'content', 'floating'] as const).map(group =>
            <View style={styles.column} key={group}>
                <GlassSurface surfaceGroup={group} finishRole={group === 'content' ? 'card' : group === 'floating' ? 'floating' : null} testID={`soft-glass-${group}`} style={styles.glass}>
                    <Text style={styles.groupTitle}>{group}</Text>
                    <Text style={styles.bodyText}>The colored backdrop crosses behind this material.</Text>
                    <GlassSurface surfaceGroup={group} nested finishRole="card" testID={`soft-glass-nested-${group}`} style={styles.nested}>
                        <Text style={styles.bodyText}>Nested same-group surface</Text>
                    </GlassSurface>
                    <Buttons />
                </GlassSurface>
            </View>)}</View>
        <Composer />
    </ListPresentationProvider>;
}

/** Real shell plane and list owners; fixture labels, no authenticated session subscription. */
function Shell() {
    return <View style={{ height: 680 }} testID="glass-audit-shell">
        <AppShellMaterialFrame showChrome dragEnabled={false} leftOffsetPx={280} sidebarWidth={220}
            titleStrip={<Text style={styles.groupTitle}>Happier · fixture shell</Text>} rail={null} peek={null}
            column={<ItemList><CompactSearchField value="" onChangeText={noop} placeholder="Search sessions" />
                {ROWS.map(row => <Item key={row} title={row} onPress={noop} />)}
            </ItemList>}>
            <View style={{ padding: 16 }}><Settings /></View>
        </AppShellMaterialFrame>
    </View>;
}

/** Current production paint owners, with fixture data and no Account writes. */
function Audit(props: Readonly<{ inputAudit?: boolean }>) {
    const { theme } = useUnistyles();
    const anchor = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    return <ListPresentationProvider value="grouped">
        <PageHeader title="Glass paint audit" description="Rows, fields, buttons and floating surfaces over a detailed backdrop." />
        <View ref={anchor} collapsable={false}><RoundButton testID="glass-audit-open" title="Open popover" display="secondary" onPress={() => setOpen(value => !value)} /></View>
        <Popover open={open} anchorRef={anchor} onRequestClose={() => setOpen(false)} minWidth={320} portal={{ web: true, matchAnchorWidth: false }}>
            {() => <FloatingOverlay scrollEnabled={false} maxHeight={520} header={<Text testID="glass-audit-popover-title" style={styles.groupTitle}>Harness updates available</Text>} footer={<Buttons />}>
                <ItemGroup header="none" surface="none">{ROWS.map(row => <Item key={row} title={row} detail="Update" onPress={noop} />)}</ItemGroup>
            </FloatingOverlay>}
        </Popover>
        <View style={styles.grid}>{(['chrome', 'sidebar', 'content', 'floating'] as const).map(group => <View key={group} style={styles.column}>
            <GlassSurface surfaceGroup={group} testID={`glass-audit-${group}`} style={styles.glass}>
                <Text style={styles.groupTitle}>{group}</Text>
                <CompactSearchField testID={`glass-audit-field-${group}`} value="settings" onChangeText={noop} placeholder="Search" />
                {props.inputAudit ? <MachineSetupTextField testID={`glass-audit-machine-${group}`} label="Canonical styled input" value="Host field" onChangeText={noop} /> : null}
                {props.inputAudit && group === 'floating' ? <FileActionToolbar theme={theme} displayMode="file" onDisplayMode={noop}
                    diffMode="pending" onDiffMode={noop} hasPendingDelta={false} hasIncludedDelta={false} scmWriteEnabled={false}
                    includeExcludeEnabled={false} virtualSelectionEnabled={false} isSelectedForCommit={false} lineSelectionEnabled={false}
                    selectedLineCount={0} isApplyingStage={false} inFlightScmOperation={null} onStageFile={noop} onUnstageFile={noop}
                    onApplySelectedLines={noop} onClearSelection={noop} fileEditorEnabled isEditingFile showMarkdownEditToggle
                    markdownEditMode="rich" markdownRichEligible onMarkdownEditMode={noop} /> : null}
                <SegmentedTabBar tabs={[{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }]} activeTabId="one" onSelectTab={noop} testIDPrefix={`glass-audit-segment-${group}`} />
                <ItemGroup header="none" surface="none"><Item testID={`glass-audit-row-${group}`} title="Review the settings modal" subtitle="Rows keep the backdrop visible" onPress={noop} /></ItemGroup>
                <Buttons />
            </GlassSurface>
        </View>)}</View>
        <FloatingOverlay surfaceChrome="theme" scrollEnabled={false}><Item title="Theme form material" onPress={noop} /><Buttons /></FloatingOverlay>
    </ListPresentationProvider>;
}

const styles = StyleSheet.create(theme => ({
    stage: { flex: 1, backgroundColor: theme.colors.background.canvas },
    backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden' },
    backdropBand: { position: 'absolute', width: '48%', height: '100%', left: '26%', backgroundColor: theme.colors.state.info.foreground },
    backdropAccent: { position: 'absolute', width: '33%', height: '100%', right: 0, backgroundColor: theme.colors.state.warning.foreground },
    backdropDetail: { position: 'absolute', left: 0, right: 0, height: 6, backgroundColor: theme.colors.text.primary, opacity: 0.08 },
    page: { gap: theme.margins.lg, padding: theme.margins.xl, maxWidth: 1100, width: '100%', alignSelf: 'center' },
    basis: { ...Typography.mono(), fontSize: 11, color: theme.colors.text.secondary },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.margins.lg },
    column: { flex: 1, flexBasis: 320, minWidth: 0, gap: theme.margins.lg },
    buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.margins.sm },
    muted: { color: theme.colors.text.secondary },
    bodyText: { color: theme.colors.text.primary },
    glass: { minHeight: 220, padding: theme.margins.lg, borderRadius: theme.borderRadius.xl, gap: theme.margins.lg },
    nested: { padding: theme.margins.md, borderRadius: theme.borderRadius.md },
    groupTitle: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
}));

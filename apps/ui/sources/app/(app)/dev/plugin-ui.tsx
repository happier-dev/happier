import {
    Action as PluginAction,
    ActionPanel as PluginActionPanel,
    Button as PluginButton,
    Badge as PluginBadge,
    Banner as PluginBanner,
    BrandMark as PluginBrandMark,
    Card as PluginCard,
    CodeBlock as PluginCodeBlock,
    ContextMenu as PluginContextMenu,
    Divider as PluginDivider,
    Dropdown as PluginDropdown,
    defineUiSurface,
    EmptyState as PluginEmptyState,
    ErrorState as PluginErrorState,
    LoadingState as PluginLoadingState,
    Form as PluginForm,
    Heading as PluginHeading,
    Icon as PluginIcon,
    IconButton as PluginIconButton,
    Image as PluginImage,
    Label as PluginLabel,
    Link as PluginLink,
    List as PluginList,
    Item as PluginItem,
    ItemGroup as PluginItemGroup,
    Markdown as PluginMarkdown,
    Menu as PluginMenu,
    Metadata as PluginMetadata,
    Popover as PluginPopover,
    Progress as PluginProgress,
    Row as PluginRow,
    Screen as PluginScreen,
    ScrollArea as PluginScrollArea,
    Stack as PluginStack,
    Spinner as PluginSpinner,
    State as PluginState,
    Status as PluginStatus,
    Surface as PluginSurface,
    Text as PluginText,
    Tabs as PluginTabs,
} from '@happier-dev/plugin-ui';
import {
    HappierBadge,
    HappierBanner,
    HappierDivider,
    HappierHeading,
    HappierLink,
    HappierMetadata,
    HappierProgress,
    HappierTabs,
} from '@happier-dev/plugin-ui/presentation';
import {
    HappierUiEnvironmentProvider,
    type HappierUiEnvironment,
} from '@happier-dev/plugin-ui/environment';
import type { PluginUiHostApi, RenderContext, SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from '@happier-dev/protocol/plugins/ui';
import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { createPluginUiPrivatePresentationHost } from '@/components/plugins/surfaces/pluginUiPrivatePresentationHost';
import {
    createPluginSurfaceContext,
    usePluginSurfaceAccountEncryptionMode,
    usePluginSurfaceEnvironment,
    type PluginSurfaceEnvironment,
} from '@/components/plugins/surfaces/pluginSurfaceContext';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { sync } from '@/sync/sync';

/**
 * The deterministic in-app mount for each graduated shared-presentation family
 * (§8.2).
 *
 * It renders every family through BOTH adapters side by side — Happier core's
 * and the plugin surface's — so the §7 layer-6 browser and device lanes have one
 * stable place to prove that "shared" really means shared, and so a visual
 * divergence between the two is visible to a human at a glance.
 *
 * Not a catalog or an authoring system: it is one more screen under the existing
 * `dev/**` demo-surface owner, exactly like `typography`, `list-demo` and the
 * other 24.
 */
const PLUGIN_UI_DEMO_TRANSLATIONS: Readonly<Record<string, string>> = {
    'dev.pluginUi.translated': 'Resolved from the plugin translation bundle',
};

type DemoSurfaceContext = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    context: SurfaceContext | null;
    environment: PluginSurfaceEnvironment;
}>;

function useDemoSurfaceContext(): DemoSurfaceContext {
    const environment = usePluginSurfaceEnvironment(resolveLocalServicePreviewPlatform());
    // This route is still an executable public SDK mount. It therefore uses
    // the same Account lifetime and canonical cache reader as a production
    // surface rather than fabricating a public Account-mode disclosure.
    const [, refreshAfterAccountRetirement] = React.useReducer((revision: number) => revision + 1, 0);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    React.useEffect(() => {
        const retirement = accountLifetime?.onRetire(refreshAfterAccountRetirement);
        return () => retirement?.dispose();
    }, [accountLifetime]);
    const credentials = sync.getCredentials();
    const credentialScope = credentials ? resolveAuthCredentialsScopeKey(credentials) : null;
    const isAccountEncryptionModeCurrent = React.useCallback((): boolean => {
        const currentCredentials = sync.getCredentials();
        return Boolean(
            credentialScope
            && currentCredentials
            && accountLifetime?.isCurrent() === true
            && resolveAuthCredentialsScopeKey(currentCredentials) === credentialScope,
        );
    }, [accountLifetime, credentialScope]);
    const accountEncryptionMode = usePluginSurfaceAccountEncryptionMode({
        accountLifetime,
        credentials,
        isCurrent: isAccountEncryptionModeCurrent,
    });
    const context = React.useMemo(() => {
        if (!accountLifetime || !accountEncryptionMode || !isAccountEncryptionModeCurrent()) {
            return null;
        }
        return createPluginSurfaceContext({
            // This in-app authoring demo is not a Registry destination. Model it as
            // the closed embedded arm instead of inventing a destination binding.
            mount: {
                kind: 'embedded',
                role: 'dev-plugin-ui-shared-presentation',
                presentation: 'content',
            },
            target: { kind: 'app' },
            accountEncryptionMode,
            environment,
            translations: PLUGIN_UI_DEMO_TRANSLATIONS,
            targetedContributions: {
                target: {
                    pluginId: 'happier.dev',
                    immutableGenerationId: 'dev-plugin-ui-shared-presentation',
                },
                points: [],
            },
        });
    }, [accountEncryptionMode, accountLifetime, environment, isAccountEncryptionModeCurrent]);
    return React.useMemo(
        () => ({ accountLifetime, context, environment }),
        [accountLifetime, context, environment],
    );
}

type DemoSurfaceHost = Readonly<{
    renderContext: RenderContext;
    presentationHost: ReturnType<typeof createPluginUiPrivatePresentationHost>;
    push: (context: SurfaceContext) => void;
}>;

/**
 * A bound surface controller shaped like the real one (§3.1): ONE `hostApi`
 * instance for the mounted surface, whose `watchContext` is a real producer.
 *
 * The render context is built once, from the FIRST snapshot, and every later
 * theme / text-scale change reaches the surface only through `watchContext`.
 * That is deliberate: it makes this screen falsify "the surface is pinned to the
 * facts the host held at mount" — a provider that re-read its `context` prop
 * would still look correct here if the prop were also refreshed.
 */
function createDemoSurfaceHost(initial: SurfaceContext): DemoSurfaceHost {
    let current = initial;
    const listeners = new Set<(context: SurfaceContext) => void>();
    const hostApi = {
        version: () => ({
            apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
            wireVersion: 1,
            methods: ['context', 'watchContext'],
        }),
        context: async () => current,
        watchContext: async (listener: (context: SurfaceContext) => void) => {
            listeners.add(listener);
            return {
                dispose() {
                    listeners.delete(listener);
                },
            };
        },
        // Slow on purpose: the action family's pending state is only observable
        // — live, or in the layer-6 lanes — while a dispatch is unresolved.
        executeAction: (async () => {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            return null;
        }) as PluginUiHostApi['executeAction'],
        selectActionInput: async () => {
            throw new Error('dev surface has no Action input selector');
        },
        openNewSession: async () => {
            throw new Error('dev surface cannot open New Session');
        },
        settleEphemeralInput: async () => {
            throw new Error('dev surface has no ephemeral input');
        },
        readResource: async () => {
            throw new Error('dev surface has no resources');
        },
        statOpenableContent: async () => ({ status: 'unsupported' as const }),
        readOpenableContent: async () => ({ status: 'unsupported' as const }),
        watchResource: async () => {
            throw new Error('dev surface has no resources');
        },
        activeComposer: async () => {
            throw new Error('dev surface has no Composer');
        },
        readComposer: async () => {
            throw new Error('dev surface has no Composer');
        },
        watchComposer: async () => {
            throw new Error('dev surface has no Composer');
        },
        applyComposer: async () => {
            throw new Error('dev surface has no Composer');
        },
        focusComposer: async () => {
            throw new Error('dev surface has no Composer');
        },
        setComposerDecorations: async () => {
            throw new Error('dev surface has no Composer');
        },
        acquireComposerInputLock: async () => {
            throw new Error('dev surface has no Composer');
        },
        pickComposerMedia: async () => {
            throw new Error('dev surface has no Composer');
        },
        inspectComposerContent: async () => {
            throw new Error('dev surface has no Composer');
        },
        releaseComposerContent: async () => {
            throw new Error('dev surface has no Composer');
        },
        publishCurrentUiContext: () => undefined,
        openSurface: async () => undefined,
        replacePageLocation: async () => {
            throw new Error('dev surface has no page location');
        },
        notify: async () => undefined,
        confirm: async () => false,
        diagnostic: () => undefined,
        readClipboard: async () => '',
        writeClipboard: async () => undefined,
        openExternalLink: async () => undefined,
    } satisfies PluginUiHostApi;

    const renderContext = {
        plugin: Object.freeze({ id: 'happier.dev', version: '1.0.0' }),
        surface: initial,
        hostApi,
        signal: new AbortController().signal,
    } satisfies RenderContext;
    return {
        renderContext: Object.freeze(renderContext),
        presentationHost: createPluginUiPrivatePresentationHost({ displayName: 'Happier Dev' }),
        push(next: SurfaceContext) {
            current = next;
            for (const listener of listeners) listener(next);
        },
    };
}

/**
 * The artifact installs this environment inside `PluginUiProvider`. These core
 * samples intentionally remain a sibling so the demo can show both adapters;
 * adapt the page's existing environment facts instead of creating another
 * theme, accessibility, or localization owner.
 */
function createDemoCorePresentationEnvironment(environment: PluginSurfaceEnvironment): HappierUiEnvironment {
    return {
        theme: environment.theme,
        localization: {
            locale: environment.locale,
            direction: environment.direction,
            translate: (key, fallback) => PLUGIN_UI_DEMO_TRANSLATIONS[key] ?? fallback ?? '',
        },
        accessibility: {
            textScale: environment.textScale,
            reducedMotion: environment.reducedMotion,
            screenReaderEnabled: environment.screenReaderEnabled,
            contrast: environment.contrast,
        },
        platform: {
            platform: environment.platform,
            colorScheme: environment.colorScheme,
        },
        insets: {
            safeArea: environment.safeAreaInsets,
        },
    };
}

function Sample({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
    return (
        <View style={styles.sample} testID={`plugin-ui-sample-${title.replace(/\s+/gu, '-').toLowerCase()}`}>
            <Text style={styles.sampleTitle}>{title}</Text>
            {children}
        </View>
    );
}

/**
 * The resolvable states of a resource, rendered through the plugin adapters.
 *
 * `State` is mounted with a real snapshot per status rather than the individual
 * views alone: the thing that regressed before was the DISCRIMINATION — an
 * unresolved resource rendered an inert element instead of a loading state.
 */
function PluginStateSamples() {
    return (
        <View>
            <Sample title="Plugin State — loading">
                <PluginState resource={{ status: 'loading' }} />
            </Sample>
            <Sample title="Plugin State — empty">
                <PluginState
                    resource={{ status: 'empty' }}
                    empty={<PluginEmptyState title="No findings" description="This project is clean." testID="plugin-empty-state" />}
                />
            </Sample>
            <Sample title="Plugin State — error">
                <PluginState resource={{ status: 'error', message: 'The review service did not answer.' }} />
            </Sample>
            <Sample title="Plugin State — ready">
                <PluginState resource={{ status: 'ready', value: '4 findings' }}>
                    {(value: string) => <PluginText value={value} testID="plugin-state-ready" />}
                </PluginState>
            </Sample>
            <Sample title="Plugin LoadingState with copy">
                <PluginLoadingState title="Checking the workspace" description="This usually takes a moment." testID="plugin-loading-state" />
            </Sample>
            <Sample title="Plugin ErrorState">
                <PluginErrorState title="Could not reach the server" description="Retry once the daemon is back." testID="plugin-error-state" />
            </Sample>
            <Sample title="Plugin Spinner tones">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <PluginSpinner accessibilityLabel="Loading" testID="plugin-spinner-default" />
                    <PluginSpinner size="large" tone="accent" accessibilityLabel="Loading accent" />
                </View>
            </Sample>
            <Sample title="Plugin Status">
                <PluginStatus tone="success" label="Connected" testID="plugin-status-success" />
                <PluginStatus tone="warning" label="Degraded" pulsing />
                <PluginStatus tone="danger" label="Disconnected" />
            </Sample>
            <PluginButtonSamples />
            <PluginActionSamples />
            <PluginExpandedSamples />
        </View>
    );
}

function PluginExpandedSamples() {
    const [formValue, setFormValue] = React.useState<Record<string, unknown>>({ name: 'Preview', enabled: true });
    const [popoverOpen, setPopoverOpen] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [dropdownOpen, setDropdownOpen] = React.useState(false);
    const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
    const [scope, setScope] = React.useState<'project' | 'workspace'>('project');
    const [lastOverlayAction, setLastOverlayAction] = React.useState<string | null>(null);
    const [tab, setTab] = React.useState('summary');
    return (
        <PluginScreen>
            <PluginScrollArea>
                <PluginStack gap="small">
                    <PluginHeading value="Presentation families" level={2} />
                    <PluginLabel value="Shared owner" />
                    <PluginRow gap="small">
                        <PluginIcon name="check" accessibilityLabel="Ready" />
                        <PluginBadge value="Preview" />
                    </PluginRow>
                    <PluginDivider />
                    <PluginMetadata entries={[{ label: 'Owner', value: 'plugin-ui' }]} />
                    <PluginLink title="Documentation" url="https://example.test" />
                    <PluginProgress value={0.5} label="Half complete" />
                    <PluginBanner title="Portable" description="One shared presentation seam." tone="info" />
                    <PluginMarkdown value="**Markdown** through the incumbent renderer." />
                    <PluginCodeBlock code="const shared = true;" language="ts" copyLabel="Copy code" />
                    <PluginBrandMark showName />
                    <PluginImage
                        resource={{ pluginId: 'happier.dev', localId: 'missing-preview-image' }}
                        accessibilityLabel="Missing preview image"
                        fallback="P"
                    />
                    <PluginList accessibilityLabel="Example list">
                        <PluginList.Section title="Section">
                            <PluginList.Item
                                secondaryActions={[{ id: 'inspect-preview', label: 'Inspect preview' }]}
                                secondaryActionAccessibilityLabel="Preview actions"
                                onSecondaryAction={(id) => setLastOverlayAction(`List action: ${id}`)}
                            ><PluginText value="Item" /></PluginList.Item>
                        </PluginList.Section>
                    </PluginList>
                    <PluginItemGroup accessibilityLabel="Standalone item group">
                        <PluginItem title="Standalone item" subtitle="Shared row and group semantics" />
                        <PluginIconButton
                            accessibilityLabel="Refresh preview"
                            icon={<PluginIcon name="refresh" />}
                            onPress={() => undefined}
                        />
                    </PluginItemGroup>
                    <PluginForm
                        hints={{ fields: [
                            { path: 'name', title: 'Name', widget: 'text', required: true },
                            { path: 'enabled', title: 'Enabled', widget: 'boolean' },
                        ] }}
                        value={formValue}
                        onChange={setFormValue}
                        onSubmit={() => undefined}
                    />
                    <PluginPopover
                        open={popoverOpen}
                        onOpenChange={setPopoverOpen}
                        trigger="Popover"
                        triggerAccessibilityLabel="Open popover"
                    ><PluginText value="Popover content" /></PluginPopover>
                    <PluginMenu
                        open={menuOpen}
                        onOpenChange={setMenuOpen}
                        trigger="Menu"
                        triggerAccessibilityLabel="Open menu"
                        items={[{ id: 'refresh', label: 'Refresh' }]}
                        onSelect={(id) => setLastOverlayAction(`Menu action: ${id}`)}
                    />
                    <PluginDropdown
                        open={dropdownOpen}
                        onOpenChange={setDropdownOpen}
                        trigger="Dropdown"
                        triggerAccessibilityLabel="Open dropdown"
                        radioGroups={[{ id: 'scope', accessibilityLabel: 'Preview scope', selectedId: scope }]}
                        items={[
                            { id: 'project', label: 'Project', kind: 'radio', radioGroupId: 'scope' },
                            { id: 'workspace', label: 'Workspace', kind: 'radio', radioGroupId: 'scope' },
                        ]}
                        onSelect={(id) => {
                            if (id === 'project' || id === 'workspace') setScope(id);
                        }}
                    />
                    <PluginContextMenu
                        open={contextMenuOpen}
                        onOpenChange={setContextMenuOpen}
                        trigger="Context menu"
                        triggerAccessibilityLabel="Open context menu"
                        items={[{ id: 'inspect', label: 'Inspect' }]}
                        onSelect={(id) => setLastOverlayAction(`Context action: ${id}`)}
                    />
                    <PluginText
                        value={lastOverlayAction ?? `Preview scope: ${scope}`}
                        testID="plugin-overlay-last-action"
                    />
                    <PluginTabs
                        value={tab}
                        onValueChange={setTab}
                        ariaLabel="Presentation sections"
                    >
                        <PluginTabs.Item value="summary" title="Summary" />
                        <PluginTabs.Item value="details" title="Details" />
                    </PluginTabs>
                </PluginStack>
            </PluginScrollArea>
        </PluginScreen>
    );
}

/**
 * The action family through the plugin adapters.
 *
 * This is the family every deciding author journey ends in: until it graduated,
 * an author could render a surface but nothing on it could be pressed. The
 * dispatching sample is the one that matters — the demo host's `executeAction`
 * takes 1.5s, so the pending announcement and the refusal of a second dispatch
 * are both observable in a real renderer.
 */
function PluginActionSamples() {
    const [refreshCount, setRefreshCount] = React.useState(0);
    const onRefresh = React.useCallback(() => { setRefreshCount((count) => count + 1); }, []);

    return (
        <View>
            <Sample title="Plugin ActionPanel — grouped actions">
                <PluginActionPanel title="Review actions" testID="plugin-action-panel">
                    <PluginActionPanel.Section title="Findings" testID="plugin-action-section">
                        <PluginAction.Execute
                            action={{ pluginId: 'happier.dev', localId: 'review.refresh' }}
                            input={{ scope: 'workspace' }}
                            title="Run review"
                            variant="primary"
                            testID="plugin-action-execute"
                        />
                        <PluginAction.Copy value="sha256:abcd" title="Copy digest" testID="plugin-action-copy" />
                    </PluginActionPanel.Section>
                    <PluginActionPanel.Section title="Elsewhere">
                        <PluginAction.OpenExternal url="https://happier.dev/docs" title="Open docs" testID="plugin-action-external" />
                        <PluginAction.OpenSurface view="detail" input={{ id: '7' }} title="Open detail" testID="plugin-action-surface" />
                        <PluginAction.Refresh onRefresh={onRefresh} testID="plugin-action-refresh" />
                    </PluginActionPanel.Section>
                </PluginActionPanel>
            </Sample>
            <Sample title="Plugin Action — refresh count">
                <PluginText value={`Refreshed ${refreshCount} time(s)`} testID="plugin-action-refresh-count" />
            </Sample>
        </View>
    );
}

/**
 * The pressable family through the plugin adapter.
 *
 * The async sample is the one that matters: the shared owner puts the control in
 * a real pending state until the promise settles, which is what a marker element
 * could never do and what both Happier core buttons used to implement twice.
 */
function PluginButtonSamples() {
    const runSlowAction = React.useCallback(
        () => new Promise<void>((resolve) => { setTimeout(resolve, 1500); }),
        [],
    );

    return (
        <View>
            <Sample title="Plugin Button — variants">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <PluginButton title="Run review" onPress={() => {}} testID="plugin-button-primary" />
                    <PluginButton title="Cancel" variant="secondary" onPress={() => {}} testID="plugin-button-secondary" />
                    <PluginButton title="Learn more" variant="plain" onPress={() => {}} testID="plugin-button-plain" />
                </View>
            </Sample>
            <Sample title="Plugin Button — async pending">
                <PluginButton title="Refresh findings" onPress={runSlowAction} testID="plugin-button-async" />
            </Sample>
            <Sample title="Plugin Button — disabled">
                <PluginButton title="Unavailable" disabled onPress={() => {}} testID="plugin-button-disabled" />
            </Sample>
        </View>
    );
}

/**
 * The plugin-side author surface: it installs no provider and threads no host
 * wiring, exactly like an external author's component (§3.9). Everything it
 * reads arrives through the environment the artifact entry wrapper installs.
 */
function PluginSurfaceSamples() {
    return (
        <View>
            <Sample title="Plugin title tone accent">
                <PluginText variant="title" tone="accent" value="Review summary" testID="plugin-text-title" />
            </Sample>
            <Sample title="Plugin body tone neutral">
                <PluginText value="The quick brown fox jumps over the lazy dog" testID="plugin-text-body" />
            </Sample>
            <Sample title="Plugin caption tone muted">
                <PluginText variant="caption" tone="muted" value="Last checked a moment ago" testID="plugin-text-caption" />
            </Sample>
            <Sample title="Plugin danger tone">
                <PluginText variant="label" tone="danger" value="3 findings need attention" testID="plugin-text-danger" />
            </Sample>
            <Sample title="Plugin translated key">
                <PluginText
                    valueKey="dev.pluginUi.translated"
                    fallback="Untranslated fallback"
                    testID="plugin-text-translated"
                />
            </Sample>
            <Sample title="Plugin undeclared key falls back">
                <PluginText
                    valueKey="dev.pluginUi.absent"
                    fallback="Falls back to author text, never the raw key"
                    testID="plugin-text-fallback"
                />
            </Sample>
            <Sample title="Plugin Surface">
                <PluginSurface testID="plugin-surface">
                    <PluginText value="A bounded semantic surface" />
                </PluginSurface>
            </Sample>
            <Sample title="Plugin Card">
                <PluginCard testID="plugin-card">
                    <PluginText value="A card with standard inset" />
                </PluginCard>
            </Sample>
            <PluginStateSamples />
        </View>
    );
}

/**
 * The artifact's bundle-contract export, produced exactly as a real plugin
 * produces it. The host calls it with the render context and mounts the result.
 */
const renderPluginDemoSurface = defineUiSurface(PluginSurfaceSamples);

export default function PluginUiSharedPresentationScreen() {
    const { theme } = useUnistyles();
    const demoSurface = useDemoSurfaceContext();
    const context = demoSurface.context;
    const host = React.useMemo(
        () => context ? createDemoSurfaceHost(context) : null,
        [demoSurface.accountLifetime, context?.accountEncryptionMode],
    );
    // The host is the context producer (UI-D03): a theme or text-scale change
    // reaches the mounted surface through the established subscription.
    React.useEffect(() => {
        if (!host || !context) return;
        host.push(context);
    }, [host, context]);
    const surface = React.useMemo(() => {
        if (!host) return null;
        const entry = renderPluginDemoSurface(host.renderContext) as React.ReactElement | null;
        return entry
            ? React.cloneElement(
                entry as React.ReactElement<Record<string, unknown>>,
                { presentationHost: host.presentationHost },
            )
            : null;
    }, [host]);
    const corePresentationEnvironment = React.useMemo(
        () => createDemoCorePresentationEnvironment(demoSurface.environment),
        [demoSurface.environment],
    );
    const presentationTheme = demoSurface.environment.theme;
    const [coreTab, setCoreTab] = React.useState('summary');

    return (
        <ScrollView style={styles.container} testID="dev-plugin-ui-shared-presentation">
            <View style={styles.content}>
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Text — Happier core adapter</Text>
                    <Sample title="Core default">
                        <Text testID="core-text-default">The quick brown fox jumps over the lazy dog</Text>
                    </Sample>
                    <Sample title="Core selectable scope">
                        <Text selectable testID="core-text-selectable">Selectable through the shared scope</Text>
                    </Sample>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Spinner / Status / EmptyState — Happier core adapters</Text>
                    <Sample title="Core spinner">
                        <ActivitySpinner testID="core-spinner" />
                    </Sample>
                    <Sample title="Core spinner large">
                        <ActivitySpinner size="large" testID="core-spinner-large" />
                    </Sample>
                    <Sample title="Core status dot pulsing">
                        <StatusDot color={theme.colors.status.connected} isPulsing accessibilityLabel="Connected" testID="core-status-dot" />
                    </Sample>
                    <Sample title="Core round button">
                        <RoundButton title="Run review" size="small" testID="core-round-button" action={async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); }} />
                    </Sample>
                    <Sample title="Core icon button">
                        <IconButton
                            testID="core-icon-button"
                            iconName="arrow-clockwise"
                            accessibilityLabel="Refresh findings"
                            tooltip="Refresh findings"
                            onPress={async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); }}
                        />
                    </Sample>
                    <Sample title="Core empty state">
                        <EmptyState
                            testID="core-empty-state"
                            icon={<Ionicons name="search-outline" size={32} color={theme.colors.text.secondary} />}
                            title="No findings"
                            subtitle="This project is clean."
                        />
                    </Sample>
                    <Sample title="Core surface card">
                        <SurfaceCard testID="core-surface-card">
                            <Text>A core card through the shared surface owner</Text>
                        </SurfaceCard>
                    </Sample>
                    <Sample title="Core foundation presentation">
                        <HappierUiEnvironmentProvider environment={corePresentationEnvironment}>
                            <View style={{ gap: 8 }}>
                                <HappierHeading level={2} theme={presentationTheme}>Presentation status</HappierHeading>
                                <HappierHeading level={6} theme={presentationTheme}>Shared with plugin adapters</HappierHeading>
                                <HappierDivider color={presentationTheme.colors.divider} />
                                <HappierBadge
                                    color={presentationTheme.colors.success}
                                    backgroundColor={presentationTheme.colors.elevatedSurface}
                                    borderColor={presentationTheme.colors.success}
                                    radius={presentationTheme.radii.pill}
                                    horizontalPadding={presentationTheme.spacing.small}
                                    verticalPadding={presentationTheme.spacing.xsmall}
                                >Ready</HappierBadge>
                                <HappierMetadata
                                    title="Runtime"
                                    entries={[{ label: 'Owner', value: 'plugin-ui' }]}
                                    theme={presentationTheme}
                                />
                                <HappierLink
                                    label="Open documentation"
                                    onPress={() => undefined}
                                    theme={presentationTheme}
                                >Open documentation</HappierLink>
                                <HappierProgress value={0.5} label="Half complete" theme={presentationTheme} />
                                <HappierBanner
                                    title="Portable"
                                    description="One shared presentation seam."
                                    tone="info"
                                    theme={presentationTheme}
                                />
                                <HappierTabs
                                    value={coreTab}
                                    onValueChange={setCoreTab}
                                    ariaLabel="Core presentation sections"
                                    theme={presentationTheme}
                                >
                                    <CoreTab value="summary" title="Summary"><Text>Summary content</Text></CoreTab>
                                    <CoreTab value="details" title="Details"><Text>Details content</Text></CoreTab>
                                </HappierTabs>
                            </View>
                        </HappierUiEnvironmentProvider>
                    </Sample>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Text, state and feedback — plugin surface adapters</Text>
                    {surface}
                </View>
            </View>
        </ScrollView>
    );
}

function CoreTab(_props: Readonly<{ value: string; title: string; children: React.ReactNode }>): null {
    return null;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    content: {
        padding: 16,
        gap: 24,
    },
    section: {
        gap: 12,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
    sample: {
        gap: 4,
    },
    sampleTitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
}));

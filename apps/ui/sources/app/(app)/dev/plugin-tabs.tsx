import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PluginUiHostApi, RenderContext, ResourceContent, SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import type { PluginUiDataClient } from '@happier-dev/plugin-ui/data';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from '@happier-dev/protocol/plugins/ui';
import { BUNDLED_PLUGIN_UI_APP_ARTIFACTS } from '@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts';
import { readBundledPluginUiAppArtifactAssetBytes } from '@/sync/domains/plugins/availability/bundledPluginUiArtifactAssetReader';
import { evaluatePluginUiCommonJsBundle } from '@/components/plugins/reactNative/commonJsEvaluator';
import type { PluginReactNativeSurfaceModule } from '@/components/plugins/reactNative/PluginReactNativeSurface';

import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import {
    PaneHeaderSlotProvider,
    PaneHeaderSlotScope,
    usePaneHeaderSlotBinding,
    usePublishedPaneHeaderContent,
} from '@/components/appShell/panes/paneHeaderSlot';
import { createPluginSurfaceContext, usePluginSurfaceEnvironment } from '@/components/plugins/surfaces/pluginSurfaceContext';
import { createPluginUiPrivatePresentationHost } from '@/components/plugins/surfaces/pluginUiPrivatePresentationHost';
import { projectPluginUiHostPalette } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';

/**
 * Plugin tabs round 2 fixture page (lab `plugin-tabs`): the real Channels "External conversations" and Triage
 * "PRs & Issues" session-tab surfaces, mounted through the host's plugin presentation (pane header slot, state size
 * `pane`, disclosure motion, avatar) in a 340 pt pane beside a blank page, fed deterministic fixture Resources. It is
 * the live half of the side-by-side pairs in `.happier/qa/fidelity/plugin-tabs-r2/`.
 *
 * `?tab=channels|triage&state=populated|empty|loading` (expanded rows are opened by pressing them)
 */

const SESSION_ID = 'session-fixture-1';
const NOW = Date.now();

function json(value: unknown): ResourceContent {
    return {
        contentType: 'application/json',
        digest: `sha256:${'a'.repeat(64)}`,
        bytes: new TextEncoder().encode(JSON.stringify(value)),
    };
}

const binding = (overrides: Readonly<Record<string, unknown>>) => ({
    revision: 3,
    connectionId: 'connection-telegram',
    target: { kind: 'session', summary: SESSION_ID },
    inputMode: 'addressedMessages',
    deliveryMode: 'repliesOnly',
    approval: { kind: 'off' },
    enabled: true,
    deletionState: 'none',
    ...overrides,
});

const CHANNELS_CONVERSATIONS = {
    bindings: [
        binding({ bindingId: 'b-dm', endpoint: { audience: 'direct', label: 'Leeroy Brun' }, inputMode: 'allAllowedMessages', deliveryMode: 'mirrorSession' }),
        binding({ bindingId: 'b-dev', connectionId: 'connection-discord', endpoint: { audience: 'shared', label: 'happier-dev' } }),
        binding({ bindingId: 'b-gh', connectionId: 'connection-github', endpoint: { audience: 'shared', label: '#2493 Retry relay handshake on 503' }, inputMode: 'directMentionsOnly', deliveryMode: 'finalResult' }),
        binding({ bindingId: 'b-ops', endpoint: { audience: 'shared', label: 'Ops on-call' }, inputMode: 'directMentionsOnly', deliveryMode: 'finalResult', enabled: false }),
    ],
    attention: [
        { bindingId: 'b-dm', reason: 'transcriptHistoryGap', bindingRevision: 3, frontierRevision: 2 },
        { bindingId: 'b-ops', reason: 'bindingDisabled' },
    ],
    lastDeliveries: [
        { bindingId: 'b-dev', atMs: NOW - 47 * 60_000, outcome: 'delivered' },
        { bindingId: 'b-gh', atMs: NOW - 26 * 3_600_000, outcome: 'delivered' },
    ],
};

const connection = (connectionId: string, providerPluginId: string, label: string) => ({
    connectionId,
    revision: 1,
    authorityEpoch: 1,
    providerPluginId,
    selectedMachineId: 'machine-1',
    selectedTransport: 'checkpointedPull',
    integrationPrincipalLabel: label,
    enabled: true,
    deletionState: 'none',
    maximumObservationAgeMs: 60_000,
    attention: {
        historyGap: null,
        pollFailure: null,
        bestEffortBeforeDurableAdmission: false,
        oldTransportStopUnconfirmed: false,
        endpointRetargetOwed: false,
        acceptedPossibleLoss: false,
        outwardDelivery: { retryDue: false, notDelivered: false, partial: false, outcomeUnknown: false },
    },
});

const CHANNELS_CONNECTIONS = {
    connections: [
        connection('connection-telegram', 'happier.channel-telegram', '@happier_ops_bot'),
        connection('connection-discord', 'happier.channel-discord', 'Happier Labs'),
        connection('connection-github', 'happier.scm-github', 'happier-dev app'),
    ],
};

type FixtureState = 'populated' | 'empty' | 'loading';

function readState(value: unknown): FixtureState {
    return value === 'empty' || value === 'loading' ? value : 'populated';
}

function createFixtureHostApi(context: SurfaceContext, state: FixtureState): PluginUiHostApi {
    const never = new Promise<never>(() => undefined);
    const unsupported = async (): Promise<never> => { throw new Error('The plugin tabs fixture does not support this.'); };
    const readResource = async (resource: unknown): Promise<ResourceContent> => {
        const localId = typeof resource === 'string' ? resource : (resource as { localId: string }).localId;
        if (state === 'loading') return await never;
        if (localId === 'session-conversations-v1') {
            return json(state === 'empty' ? { bindings: [] } : CHANNELS_CONVERSATIONS);
        }
        if (localId === 'connections-v1') return json(CHANNELS_CONNECTIONS);
        throw new Error(`No fixture Resource ${localId}`);
    };
    return {
        version: () => ({
            apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
            wireVersion: 1,
            methods: ['context', 'readResource', 'executeAction', 'openSurface', 'openExternalLink'],
        }),
        context: async () => context,
        widgetArea: unsupported,
        watchContext: async () => ({ dispose() {} }),
        executeAction: (async () => {
            await new Promise((resolve) => setTimeout(resolve, 900));
            return {};
        }) as PluginUiHostApi['executeAction'],
        selectActionInput: unsupported,
        readEntityDragItem: unsupported,
        updateEntityDragDrop: unsupported,
        watchEntityDragDrop: unsupported,
        openNewSession: unsupported,
        openConnectedAccounts: unsupported,
        settleEphemeralInput: unsupported,
        readResource: readResource as PluginUiHostApi['readResource'],
        statOpenableContent: async () => ({ status: 'unsupported' as const }),
        readOpenableContent: async () => ({ status: 'unsupported' as const }),
        readStoredImage: unsupported,
        watchLiveStream: unsupported,
        watchResource: unsupported,
        activeComposer: unsupported,
        readComposer: unsupported,
        watchComposer: unsupported,
        applyComposer: unsupported,
        focusComposer: unsupported,
        setComposerDecorations: unsupported,
        acquireComposerInputLock: unsupported,
        pickComposerMedia: unsupported,
        inspectComposerContent: unsupported,
        releaseComposerContent: unsupported,
        readSession: async () => null,
        watchSession: unsupported,
        respondToSessionPermission: async () => ({ status: 'refused', reason: 'sessionUnavailable' }),
        publishCurrentUiContext: () => undefined,
        openSurface: async () => undefined,
        replacePageLocation: unsupported,
        notify: async () => undefined,
        confirm: async () => false,
        diagnostic: () => undefined,
        readClipboard: async () => '',
        writeClipboard: async () => undefined,
        openExternalLink: async () => undefined,
    } as PluginUiHostApi;
}

/** Triage's session links as the Account Collection returns them: two PRs and an issue, by path. */
function createTriageDataClient(state: FixtureState): PluginUiDataClient {
    const ref = (kindId: string, entryId: string) => ({
        source: { pluginId: 'happier.scm-github', localId: 'github' },
        kindId,
        collisionScope: 'happier-dev/happier',
        entryId,
    });
    const links = state === 'empty' ? [] : [
        { rowId: 'l-2502', linkedAtMs: NOW - 12 * 60_000, entryRef: ref('pull-request', '2502') },
        { rowId: 'l-2481', linkedAtMs: NOW - 2 * 3_600_000, entryRef: ref('pull-request', '2481') },
        { rowId: 'l-2471', linkedAtMs: NOW - 3_600_000, entryRef: ref('issue', '2471') },
    ];
    const snapshot = {
        rows: links.map((link) => ({
            context: { collection: { pluginId: 'happier.triage', collectionId: 'session-links' }, rowId: link.rowId, revision: 1 },
            fields: { sessionId: SESSION_ID, linkedAtMs: link.linkedAtMs },
        })),
        hasMore: false,
        status: state === 'loading' ? 'loading' : 'ready',
    };
    return {
        collection: () => ({
            identityTag: async () => 'fixture',
            get: async (rowId: string) => {
                const link = links.find((candidate) => candidate.rowId === rowId);
                if (!link) return null;
                return {
                    rowId,
                    revision: 1,
                    value: {
                        v: 1,
                        linkTag: 'a'.repeat(43),
                        entryTag: 'b'.repeat(43),
                        sessionId: SESSION_ID,
                        linkedAtMs: link.linkedAtMs,
                        entryRef: link.entryRef,
                        identityEntryRef: link.entryRef,
                        displayPathAtLink: `happier-dev/happier#${link.entryRef.entryId}`,
                    },
                };
            },
            put: async () => { throw new Error('fixture'); },
            delete: async () => { throw new Error('fixture'); },
            query: async () => { throw new Error('fixture'); },
            batch: async () => { throw new Error('fixture'); },
        }),
        openCollectionQuery: async () => ({
            getSnapshot: () => snapshot,
            subscribe: () => () => undefined,
            refresh: async () => undefined,
            loadMore: async () => undefined,
            dispose: () => undefined,
        }),
    } as unknown as PluginUiDataClient;
}

function FixturePane(props: Readonly<{ tab: 'channels' | 'triage'; state: FixtureState; title: string }>) {
    const published = usePublishedPaneHeaderContent(props.tab);
    return (
        <View style={styles.pane}>
            <PaneHeader testID="plugin-tabs-fixture-header" title={props.title} line={published?.line ?? null} actions={published?.action} />
            <PaneHeaderSlotScope slotKey={props.tab}>
                <SurfaceStateSizeProvider size="pane">
                    <FixtureSurface tab={props.tab} state={props.state} />
                </SurfaceStateSizeProvider>
            </PaneHeaderSlotScope>
        </View>
    );
}

function FixtureSurface(props: Readonly<{ tab: 'channels' | 'triage'; state: FixtureState }>) {
    const { theme } = useUnistyles();
    const environment = usePluginSurfaceEnvironment(resolveLocalServicePreviewPlatform());
    const paneHeader = usePaneHeaderSlotBinding();
    const pluginId = props.tab === 'channels' ? 'happier.channels' : 'happier.triage';
    const artifactId = props.tab === 'channels' ? 'channels-app-native' : 'triage-session-entries-native';
    const artifact = BUNDLED_PLUGIN_UI_APP_ARTIFACTS.find((entry) => entry.pluginId === pluginId && entry.artifactId === artifactId && entry.tier === 'reactNative');
    const [loaded, setLoaded] = React.useState<Readonly<{
        artifact: typeof artifact;
        module: PluginReactNativeSurfaceModule;
    }> | null>(null);
    React.useEffect(() => {
        let active = true;
        if (!artifact) return;
        const entry = artifact.files.find((file) => file.relativePath.endsWith('/entry.cjs.bundle'));
        if (!entry) return;
        void (async () => {
            const bytes = await readBundledPluginUiAppArtifactAssetBytes(entry.asset);
            if (!bytes || !active) return;
            const renderSurface = evaluatePluginUiCommonJsBundle({
                bytes,
                identity: { pluginId: artifact.pluginId, artifactId: artifact.artifactId, digest: artifact.digest },
                requestedExport: 'renderSurface',
            }) as PluginReactNativeSurfaceModule['renderSurface'];
            if (active) setLoaded({ artifact, module: { renderSurface } });
        })().catch(() => { if (active) setLoaded(null); });
        return () => { active = false; };
    }, [artifact]);
    const context = React.useMemo(() => createPluginSurfaceContext({
        mount: {
            kind: 'destination',
            destination: props.tab === 'channels'
                ? { pluginId: 'happier.channels', localId: 'session-conversations' }
                : { pluginId: 'happier.triage', localId: 'session-linked-entries' },
            container: 'rightSidebarTab',
        },
        target: { kind: 'session', sessionId: SESSION_ID },
        // A fixture mount: no Account is read, so the disclosure is a fixed fact rather than a resolved one.
        accountEncryptionMode: 'plain',
        environment,
        translations: {},
        targetedContributions: {
            target: {
                pluginId: props.tab === 'channels' ? 'happier.channels' : 'happier.triage',
                occurrenceId: 'dev-plugin-tabs-fixture',
                sourceCustody: { kind: 'development', registeredRootId: 'dev-plugin-tabs-fixture' },
            },
            points: [],
        },
    } as Parameters<typeof createPluginSurfaceContext>[0]), [environment, props.tab]);
    const presentationHost = React.useMemo(() => createPluginUiPrivatePresentationHost(
        { displayName: props.tab === 'channels' ? 'Channels' : 'PRs & Issues' },
        {
            palette: projectPluginUiHostPalette(theme),
            stateSize: 'pane',
            ...(paneHeader === null ? {} : { paneHeader }),
        },
    ), [paneHeader, props.tab, theme]);
    return React.useMemo(() => {
        const renderContext = Object.freeze({
            plugin: Object.freeze({ id: props.tab === 'channels' ? 'happier.channels' : 'happier.triage', version: '0.0.0' }),
            surface: context,
            hostApi: createFixtureHostApi(context, props.state),
            signal: new AbortController().signal,
        }) satisfies RenderContext;
        const entry = loaded?.artifact === artifact ? loaded?.module.renderSurface(renderContext) : null;
        return entry
            ? React.cloneElement(entry as React.ReactElement<Record<string, unknown>>, {
                presentationHost,
                ...(props.tab === 'triage' ? { dataClient: createTriageDataClient(props.state) } : {}),
            })
            : null;
    }, [artifact, context, loaded, presentationHost, props.state, props.tab]);
}

export default function PluginTabsFixtureScreen() {
    const params = useLocalSearchParams<{ tab?: string; state?: string }>();
    const tab = params.tab === 'triage' ? 'triage' : 'channels';
    const state = readState(params.state);
    return (
        <ScrollView contentContainerStyle={styles.page} testID="plugin-tabs-fixture">
            <PaneHeaderSlotProvider>
                <FixturePane tab={tab} state={state} title={tab === 'channels' ? 'External conversations' : 'PRs & Issues'} />
            </PaneHeaderSlotProvider>
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: {
        flexGrow: 1,
        alignItems: 'flex-end',
        backgroundColor: theme.colors.surface.inset,
    },
    pane: {
        width: 340,
        minHeight: 780,
        backgroundColor: theme.colors.surface.base,
        borderLeftWidth: 1,
        borderLeftColor: theme.colors.border.default,
    },
}));

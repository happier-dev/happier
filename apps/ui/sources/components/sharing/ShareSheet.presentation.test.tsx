// @vitest-environment jsdom
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import type { LayoutChangeEvent } from 'react-native';
import type { CustomModalChromeConfig } from '@/modal/types';
import { act } from 'react-test-renderer';
import type { ShareSheetModel, ShareSheetActions } from './shareSheetTypes';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol';
import type { SessionAccessEditorModel, SessionAccessEditorActions } from '@/components/sessions/access/sessionAccessEditorTypes';
import { installMessageViewCommonModuleMocks } from '@/components/sessions/transcript/messageViewTestHelpers';

const capture = vi.hoisted(() => ({ dark: process.env.DV3_SHARE_CAPTURE_THEME === 'dark',
    width: Number(process.env.DV3_SHARE_CAPTURE_WIDTH ?? 390), pathname: '/settings/profiles/new',
    header: {} as Record<string, unknown>, chrome: null as CustomModalChromeConfig | null, nextLayout: 0,
    layouts: new Map<number, (event: LayoutChangeEvent) => void>() }));
// Hardware facts are fixed per process, just as the real browser pointer owner caches them.
const installBrowserFacts = () => vi.stubGlobal('navigator', { maxTouchPoints: capture.width < 600 ? 1 : 0, userAgent: capture.width < 600 ? 'Mobile' : 'Desktop',
    // Web Locks is a browser SDK boundary; this isolated fixture has one serial Home writer.
    locks: { request: async (_name: string, run: () => unknown) => await run() } });
installBrowserFacts();
beforeEach(installBrowserFacts);
// Native/theme/navigation SDK boundaries only: production components and stores stay real.
installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const web = await vi.importActual<Record<string, unknown>>('react-native-web');
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const WebView = web.View as React.ComponentType<Record<string, unknown>>;
        const MeasuredView = React.forwardRef<unknown, Record<string, unknown>>(function MeasuredView(props, ref) {
            const [layoutId] = React.useState(() => ++capture.nextLayout);
            const handler = props.onLayout;
            React.useEffect(() => {
                if (typeof handler !== 'function') return;
                capture.layouts.set(layoutId, handler as (event: LayoutChangeEvent) => void);
                return () => { capture.layouts.delete(layoutId); };
            }, [handler, layoutId]);
            return React.createElement(WebView, { ...props, ref,
                dataSet: { ...(props.dataSet as Record<string, unknown> | undefined),
                    ...(typeof handler === 'function' ? { captureLayout: layoutId } : {}) } });
        });
        return createReactNativeWebMock({ ...web, View: MeasuredView,
            useWindowDimensions: () => ({ width: capture.width, height: 1000, scale: 1, fontScale: 1 }) });
    },
    unistyles: async () => {
        const { lightTheme, darkTheme } = await import('@/theme');
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        const { StyleSheet: webStyleSheet } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
        const light = await createUnistylesMock({ theme: lightTheme });
        const dark = await createUnistylesMock({ theme: darkTheme });
        const current = () => ({ ...(capture.dark ? dark : light).useUnistyles(),
            rt: { screen: { width: capture.width, height: 1000 }, colorScheme: capture.dark ? 'dark' : 'light' } });
        return { ...light, useUnistyles: current, StyleSheet: { ...light.StyleSheet,
            absoluteFillObject: webStyleSheet.absoluteFillObject, absoluteFill: webStyleSheet.absoluteFill,
            create: (input: unknown) => {
                if (typeof input !== 'function') return input;
                const resolve = () => { const { theme, rt } = current(); return input(theme, rt) as Record<string, unknown>; };
                const entries = new Map<PropertyKey, object>();
                return new Proxy(resolve(), { get: (_target, key) => {
                    const value = Reflect.get(resolve(), key);
                    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
                    if (!entries.has(key)) entries.set(key, new Proxy(value, {
                        get: (_entry, field) => Reflect.get(Reflect.get(resolve(), key), field),
                    }));
                    return entries.get(key);
                } });
            } }, UnistylesRuntime: { ...light.UnistylesRuntime, getTheme: () => current().theme } };
    },
    text: async () => vi.importActual('@/text'),
    storage: importOriginal => importOriginal(),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { show: config => { capture.chrome = config.chrome ?? null; return 'capture-modal'; } } }).module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: () => capture.pathname, navigation: {
            setOptions: (options: Record<string, unknown>) => { Object.assign(capture.header, options); },
            addListener: () => () => {}, isFocused: () => true, canGoBack: () => false,
        } }).module;
    },
});
vi.unmock('@/components/ui/icons/Icon');
vi.unmock('@/components/ui/avatar/Avatar');
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
// Static source panels do not exercise native Markdown layout.
vi.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: (props: Record<string, unknown>) =>
    React.createElement('span', { style: props.style }, props.markdown as string) }));
vi.mock('@/components/ui/forms/Switch', async () => vi.importActual('@/components/ui/forms/Switch.web'));
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const native = await import('react-native');
    const sdk = createReanimatedModuleMock();
    const animated = { ...sdk.default, View: native.View, Text: native.Text, ScrollView: native.ScrollView };
    return { ...sdk, ...animated, default: animated };
});
// Render native image/gradient SDK inputs through real RN-web hosts, not inert test host strings.
vi.mock('expo-image', async () => {
    const { Image } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return { Image: (props: Record<string, unknown>) => {
        const source = typeof props.source === 'string' && props.source.startsWith('/')
            ? { uri: `data:image/png;base64,${readFileSync(props.source).toString('base64')}` } : props.source;
        return React.createElement(Image, { ...props, source });
    } };
});
vi.mock('expo-linear-gradient', async () => {
    const { View } = await import('react-native');
    return { LinearGradient: (props: Record<string, unknown>) => React.createElement(View,
        { ...props, style: [props.style, { backgroundImage: `linear-gradient(180deg, ${(props.colors as string[]).join(', ')})` }] }) };
});
vi.mock('@expo/vector-icons', async importOriginal => {
    const actual = await importOriginal<Record<string, unknown>>();
    const { Text } = await import('react-native');
    const glyphs = JSON.parse(readFileSync(join(process.cwd(),
        'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json'), 'utf8')) as Record<string, number>;
    return { ...actual, Ionicons: (props: Record<string, unknown>) => React.createElement(Text,
        { ...props, style: [props.style, { fontFamily: 'Ionicons', fontSize: props.size, color: props.color }] },
        String.fromCodePoint(glyphs[String(props.name)] ?? 0)) };
});
vi.mock('react-native-svg', () => {
    const host = (name: string) => (props: Record<string, unknown>) => React.createElement(name, props);
    return { ...Object.fromEntries(['Svg', 'Path', 'Circle', 'Rect', 'Defs', 'RadialGradient', 'LinearGradient', 'Stop',
        'G', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'ClipPath', 'Mask', 'Use', 'Text', 'TSpan'].map(name =>
        [name, host(name === 'Svg' ? 'svg' : name[0]!.toLowerCase() + name.slice(1))]).concat([['default', host('svg')]])),
        SvgXml: (props: Record<string, unknown>) => React.createElement('span', {
            style: { display: 'inline-flex', width: props.width, height: props.height },
            dangerouslySetInnerHTML: { __html: props.xml },
        }) };
});
// The external virtualization SDK renders its requested items for a static source capture.
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return { LegendList: createCapturingLegendListMock({ renderItems: true }).module.LegendList };
});

const { storage } = await import('@/sync/domains/state/storage');
const { renderScreen, standardCleanup } = await import('@/dev/testkit');
const { applyProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } = await import('@/sync/store/settings/profileCatalogSnapshot');
const { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { ProfileDetailScreen } = await import('@/components/settings/profiles/ProfileDetailScreen');
const { NavigationTitleChromeProvider } = await import('@/components/ui/layout/PageHeader');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { lightTheme, darkTheme } = await import('@/theme');
const { ShareSheet } = await import('./ShareSheet');
const { createDocumentShareAdapter } = await import('./documents/documentShareAdapter');
const { ModalCardFrame } = await import('@/modal/components/card/ModalCardFrame');
const { Switch } = await import('@/components/ui/forms/Switch');
const { RoleDetailScreen } = await import('@/components/settings/roles/RoleDetailScreen');
const { RoleCollectionRail } = await import('@/components/settings/roles/RoleCollectionRail');
const { ProfileCollectionRail } = await import('@/components/settings/profiles/ProfileCollectionList');
const { SavedSecretAccessEditor } = await import('@/components/secrets/SavedSecretAccessEditor');
const { SavedSecretCreateEditor } = await import('@/components/secrets/SavedSecretCreateEditor');
const { SecretsSettingsPage } = await import('@/components/settings/secrets/SecretsSettingsPage');
const { SettingsPageHeader } = await import('@/components/settings/shell/SettingsPageHeader');
const { t } = await import('@/text');
const { createSessionShareSheetAdapter } = await import('@/components/sessions/access/sessionShareSheetAdapter');
const { HappierListDetailLayout } = await import('@happier-dev/plugin-ui/presentation');
const { showDocumentShareSheet } = await import('./documents/showDocumentShareSheet');
const { presentSharePrincipal } = await import('./sharePrincipalPresentation');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { serveActionHomes } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
const { createWorkBoardArtifactBoundary } = await import('@/dev/testkit/harness/workBoardArtifactBoundary');
const { ARTIFACT_PLAIN_DATA_KEY_MARKER, createWorkBoardV1, encodePlainArtifactStoredContent } = await import('@happier-dev/protocol');
const { buildRoleArtifactHeaderV1 } = await import('@happier-dev/protocol/prompts/roles/roleArtifactV1');
const { getActiveServerSnapshot, setActiveServer } = await import('@/sync/domains/server/serverRuntime');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { useWorkBoardReadState } = await import('@/components/boards/model/useWorkBoards');
const { SessionCollaborationSurface } = await import('@/components/sessions/collaboration/SessionCollaborationSurface');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { createSessionCollaborationHttpBoundary, createCollaborationSessionRecord } = await import('@/dev/testkit/harness/sessionCollaborationNetworkBoundary');
const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { getEnabledAgentIds } = await import('@/agents/catalog/enabled');
const { getProfileSubtitle, getDefaultProfileListStrings } = await import('@/components/profiles/profileListModel');
const { normalizeSessionListFilterV1 } = await import('@happier-dev/protocol');
const { buildSessionListFilterQueryHomes } = await import('@/components/sessions/shell/search/sessionListViewFilters');
const { fromBoardSessionFilter } = await import('@/components/boards/model/boardSessionFilter');
const { useDocumentPublicLinkController } = await import('./documents/useDocumentPublicLinkController');
const { DocumentPublicLinkSection } = await import('./documents/DocumentPublicLinkSection');
const { SettingsSidebar } = await import('@/components/settings/shell/SettingsSidebar');
const { ConnectionStatusControl } = await import('@/components/navigation/ConnectionStatusControl');
const { SessionInvalidLinkFallback } = await import('@/components/sessions/shell/SessionInvalidLinkFallback');
const { AppShellMaterialFrame } = await import('@/components/navigation/shell/AppShellMaterialFrame');
const { View } = await import('react-native');
const { applyAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } = await import('@/sync/store/settings/acpCatalogSnapshot');
const { buildAgentUniverseBackendTargetKey } = await import('@/agents/catalog/agentUniverse');
let boardReadState: ReturnType<typeof useWorkBoardReadState> | null = null;
function BoardReadProbe() {
    boardReadState = useWorkBoardReadState();
    return null;
}
const scope = { serverId: 'dv3-share-home', accountId: 'dv3-share-account' };
const noop = () => {};
const reviewProfile = { v: 2 as const, id: 'review-profile', name: 'Release review with a minimal profile', createdAt: 1, updatedAt: 1,
    extraEnvironmentVariables: [], envVarRequirements: [], defaultPermissionModeByTargetKey: {},
    defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {} };
function PublicLinkCapture() {
    const link = useDocumentPublicLinkController({ artifactId: 'release-reviewer', scope, enabled: true, canManage: true });
    const adapter = { ...createDocumentShareAdapter({ artifactId: 'release-reviewer', kind: 'role.v1', grants: [], loading: false,
        readOnly: false, retryContent: noop, linkPath: '/settings/roles/release-reviewer', sendCopy: noop }),
        publicLink: { stateLabel: t(link.publication ? 'common.on' : 'common.off'),
            renderContent: (context: { idPrefix: string }) => <DocumentPublicLinkSection link={link} idPrefix={context.idPrefix} /> } };
    return <ModalCardFrame title="Share Code reviewer" subtitle="Role · Default agent · Session"
        presentation={capture.width < 600 ? 'sheet' : 'card'} sheetBottomInset={capture.width < 600 ? 24 : 0}
        dimensions={{ width: 560, maxHeightRatio: 0.92 }} onClose={noop} testID="public-link-modal">
        <ShareSheet model={model} actions={actions} adapter={adapter} presentation="full" onRequestClose={noop} testID="public-link-share" />
    </ModalCardFrame>;
}
const actions: ShareSheetActions = { setQuery: noop, retryDirectory: noop, loadMore: noop, addPrincipal: noop,
    retryMutation: noop, setAccessLevel: noop, requestRemove: noop, confirmRemove: noop, cancelRemove: noop, explain: noop };
const model: ShareSheetModel = { revision: 1, editable: true, stale: false,
    owner: { principal: presentSharePrincipal({ ref: { kind: 'account', accountId: scope.accountId },
        profile: { firstName: 'Leeroy', lastName: 'Brun', username: 'leeroy', avatarUrl: null }, viewerAccountId: scope.accountId }) },
    grants: [{ grant: { kind: 'team', teamId: 'happier-team' }, principal: { ref: { kind: 'team', teamId: 'happier-team' },
        key: 'team:happier-team', displayName: 'Happier Team', accessibilityLabel: 'Happier Team' },
        level: { kind: 'editable', value: 'edit', options: ['view', 'edit', 'admin'] }, removal: { kind: 'allowed' }, operation: { kind: 'idle' } }],
    directory: { query: '', sections: [{ kind: 'account', title: 'People', status: 'idle', cursor: null,
        hasMore: false, loadingMore: false, candidates: [{ principal: { ref: { kind: 'account', accountId: 'collaborator' },
            key: 'account:collaborator', displayName: 'Maya Chen', secondaryLabel: '@maya', avatar: { id: 'collaborator' },
            accessibilityLabel: 'Maya Chen' }, addition: { kind: 'allowed' }, operation: { kind: 'idle' } }] },
        { kind: 'team', title: 'Teams', status: 'idle', cursor: null, hasMore: false, loadingMore: false, candidates: [] },
        { kind: 'group', title: 'Groups', status: 'idle', cursor: null, hasMore: false, loadingMore: false, candidates: [] }] } };
const secret = { ref: 'happier:shared-secret:v1:dv3-secret', source: 'shared_resource', relationship: 'owner', name: 'Deployment token',
    kind: 'apiKey', encryptionMode: 'plain', owner: null, accessSources: [], audience: { accounts: [], teams: [], groups: [] },
    ownerAccountId: scope.accountId, revision: 3, materialStatus: 'ready',
    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } as const satisfies SavedSecretCatalogEntryV1;

afterEach(() => { standardCleanup(); storage.setState(storage.getInitialState(), true);
    resetProfileCatalogSnapshotsForTests(); resetPromptLibraryCatalogSnapshotsForTests(); resetAcpCatalogSnapshotsForTests(); });

function seed() {
    capture.header = {};
    const server = getActiveServerSnapshot();
    publishAppliedActiveServerSnapshot(server.serverId === scope.serverId ? server
        : { serverId: scope.serverId, serverUrl: 'https://dv3-share.test', generation: 0 });
    storage.setState({ profileScope: scope, settingsScope: scope });
    storage.getState().applySettingsLocal({ useProfiles: true });
    applyAcpCatalogSnapshot(scope, { status: 'ready', source: 'fresh', revision: 'absent', sourceSettingsVersion: 0,
        record: { v: 1, definitions: [] } }, true);
    applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready',
        rows: [{ record: { key: 'role-overrides', value: { v: 1, overrides: {} } }, revision: 1 }],
        tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 0 }, true);
    applyProfileCatalogSnapshot(scope, { status: 'ready', source: 'destination', authority: 'active', control: null,
        controlRevision: 1, referenceGuardRevision: 1, diagnostics: [], records: [{ revision: 1,
            record: { v: 1, id: 'review-profile', enabled: true, promptStack: [], secretBindings: {}, definition: { kind: 'inline',
                profile: reviewProfile } } }] }, true);
}

function hostTree(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): React.ReactNode {
    if (node === null || typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(hostTree);
    return React.createElement(node.type, node.props, ...(node.children ?? []).map(hostTree));
}

function sourceText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
    if (node === null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(sourceText).join('');
    return (node.children ?? []).map(sourceText).join('');
}

it('keeps the launch profile Save action visible in phone navigation before opening overflow', async () => {
    capture.width = 390;
    seed();
    await renderScreen(<NavigationTitleChromeProvider showsTitle>
        <ProfileDetailScreen target={{ kind: 'draft', cloneFrom: null }} />
    </NavigationTitleChromeProvider>);
    const headerRight = capture.header.headerRight;
    expect(typeof headerRight).toBe('function');
    const header = await renderScreen((headerRight as () => React.ReactNode)());
    expect(header.findByTestId('settings.profiles.detail.save')).not.toBeNull();
});

const variants = [{ dark: capture.dark, width: capture.width }];
it.each(variants)('captures SHARE source owners ($dark / $width)', async variant => {
    if (!process.env.DV3_SHARE_CAPTURE_DIR) return;
    Object.assign(capture, variant);
    seed();
    const output = process.env.DV3_SHARE_CAPTURE_DIR!;
    mkdirSync(output, { recursive: true });
    const theme = capture.dark ? darkTheme : lightTheme;
    const web = await vi.importActual<{ StyleSheet: { getSheet(): { textContent: string } } }>('react-native-web');
    const fonts = ['Inter-Regular', 'Inter-Medium', 'Inter-SemiBold'].map(name =>
        `@font-face{font-family:${name};src:url(data:font/ttf;base64,${readFileSync(join(process.cwd(), `sources/assets/fonts/${name}.ttf`)).toString('base64')})}`).join('')
        + `@font-face{font-family:Ionicons;src:url(data:font/ttf;base64,${readFileSync(join(process.cwd(),
            'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf')).toString('base64')})}`;
    const documentHtml = (body: string) => `<!doctype html><html><meta charset="utf-8"><style>${fonts}${web.StyleSheet.getSheet().textContent}
        body{margin:0;background:${theme.colors.surface.base};color:${theme.colors.text.primary};font:14px system-ui}section{padding:24px;min-width:0}h2{font-size:13px;margin:0 0 16px;color:${theme.colors.text.secondary}}.collection-scene{display:flex;flex-direction:column;height:1400px}@media(max-width:600px){section{padding:0 0 24px}h2{padding:16px}}</style><body>${body}</body></html>`;
    // Replay real Chromium geometry through the native onLayout boundary before serializing.
    // This is required for responsive section actions; static HTML alone cannot run RN layout callbacks.
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ executablePath: process.env.DV3_SHARE_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: capture.width, height: 1000 }, hasTouch: capture.width < 600 });
    const settle = async (screen: Awaited<ReturnType<typeof renderScreen>>) => {
        let previous: string | null = null;
        while (true) {
            const body = renderToStaticMarkup(<section>{hostTree(screen.tree.toJSON())}</section>);
            if (body === previous) return;
            previous = body;
            await page.setContent(documentHtml(body));
            await page.evaluate(() => document.fonts.ready);
            const boxes = await page.evaluate(() => Array.from(document.querySelectorAll('[data-capture-layout]')).map(element => {
                const rect = element.getBoundingClientRect();
                const parent = element.parentElement?.getBoundingClientRect();
                return { id: Number(element.getAttribute('data-capture-layout')), width: rect.width, height: rect.height,
                    x: rect.x - (parent?.x ?? 0), y: rect.y - (parent?.y ?? 0) };
            }));
            await act(async () => {
                for (const box of boxes) capture.layouts.get(box.id)?.({ nativeEvent: { layout: box } } as LayoutChangeEvent);
            });
        }
    };
    let disposeHome: (() => void) | undefined;
    const prerequisites: string[] = [];
    try {
    // Canonical Board fixture transport supplies real retained data through the actual Account/HTTP reader.
    let boardBoundary: ReturnType<typeof createWorkBoardArtifactBoundary> | null = null;
    const collaborationBoundary = createSessionCollaborationHttpBoundary();
    const collaborationHome = collaborationBoundary.addHome('https://dv3-share.test', scope.accountId);
    collaborationHome.sessions.set('release', createCollaborationSessionRecord('release'));
    const roleDocument = { name: 'Code reviewer', instructions: 'Review changes for correctness and clarity.',
        runsAs: { kind: 'session' }, workspaceWrites: 'deny', secondOpinion: 'encouraged', enabled: true,
        engine: { agentTargetKey: buildAgentUniverseBackendTargetKey('codex'), modelId: 'gpt-6', effort: 'high' } } as const;
    const home = await serveActionHomes({ homes: [{ key: 'share', serverUrl: 'https://dv3-share.test', accountId: scope.accountId,
        settings: { useProfiles: true } }], route: request => {
        if (request.path.startsWith('/v2/sessions') || request.path.startsWith('/v1/sessions') || request.path === '/v1/features') {
            return collaborationBoundary.route(request);
        }
        if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (request.path === '/v1/public-shares') return request.method === 'POST'
            ? Response.json({ error: 'public_share_isolation_unavailable' }, { status: 503 })
            : Response.json({ publicShares: [] });
        if (request.path === '/v1/user/search') return Response.json({ users: [{ id: 'collaborator',
            firstName: 'Maya', lastName: 'Chen', avatar: null, username: 'maya', bio: null, badges: [],
            status: 'none', publicKey: null }], nextCursor: null });
        if (request.path === '/v1/teams/list') return Response.json({ items: [], nextCursor: null });
        if (request.path === '/v1/artifacts/board/access/grants') return Response.json({
            artifactId: 'board', ownerAccountId: scope.accountId, access: 'owner', grants: [] });
        const rows = [...(boardBoundary?.rows.values() ?? []), { artifactId: 'release-reviewer',
            header: buildRoleArtifactHeaderV1(roleDocument), body: JSON.stringify(roleDocument),
            revision: { headerVersion: 1, bodyVersion: 1 } }].map(row => ({ id: row.artifactId,
            header: encodePlainArtifactStoredContent(row.header), body: encodePlainArtifactStoredContent({ body: row.body }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: row.revision.headerVersion,
            bodyVersion: row.revision.bodyVersion, seq: 1, createdAt: 1, updatedAt: 1, ownerAccountId: scope.accountId,
            access: 'owner', publicAudience: 'none', encryptionMode: 'plain' }));
        if (request.path === '/v1/artifacts') return Response.json(rows);
        const row = rows.find(item => request.path === `/v1/artifacts/${item.id}`);
        return row ? Response.json(row) : undefined;
    } });
    disposeHome = home.dispose;
    scope.serverId = home.homes.share!.id;
    await setActiveServer({ serverId: scope.serverId, scope: 'device' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    seed();
    storage.setState({ isDataReady: true });
    const filteredSessionIds = Array.from({ length: 10 }, (_, index) => `filtered-${index + 1}`);
    const boardFilter = normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [scope.serverId] });
    const board = { ...createWorkBoardV1({ id: 'board', name: 'Release workspace' }), source: { picked:
        [{ kind: 'session' as const, qualifiedId: { serverId: scope.serverId, id: 'release' } }], filter: boardFilter } };
    // The filter's retained corpus is canonical store state, separate from the one hand-picked member.
    // This source renderer has no live Socket; retained membership remains truthful without claiming fresh coverage.
    for (const queryHome of buildSessionListFilterQueryHomes(fromBoardSessionFilter(boardFilter, [scope.serverId]),
        { storage: 'active', includeInactive: false, mountedHomeServerIds: [scope.serverId] })) {
        storage.getState().commitSessionListQueryMembership(queryHome.queryKey,
            { serverId: scope.serverId, accountId: scope.accountId, sessionIds: filteredSessionIds, lastKnown: true });
    }
    storage.setState({ sessionListRowsByServerId: { [scope.serverId]: Object.fromEntries(['release', ...filteredSessionIds]
        .map(id => [id, createSessionListRenderableSessionFixture({ id })])) } });
    boardBoundary = createWorkBoardArtifactBoundary({ v: 1, boards: [board] });
    // Exercise the actual deferred Account reader first so a missing HTTP prerequisite is observable.
    try {
        const boardAccount = await captureLazyActionAccountContext(scope.serverId);
        try { expect((await boardAccount.workflowArtifacts.read('board'))?.body).toBe(JSON.stringify(board)); }
        finally { boardAccount.dispose(); }
    } catch (error) { prerequisites.push(`Board Account read: ${String(error)}`); }
    const credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.share!.serverUrl);
    if (!credentials) throw new Error('Source Home fixture supplied no credentials');
    const panels: Array<{ id: string; body: React.ReactNode }> = [];
    const emit = async (panel: { id: string; body: React.ReactNode }) => {
        if (process.env.DV3_SHARE_CAPTURE_PANEL === 'secrets' && !panel.id.startsWith('secret-access-') && panel.id !== 'secret-create') return;
        panels.push(panel);
        const html = documentHtml(renderToStaticMarkup(<section data-capture-panel={panel.id}>
            <h2>{panel.id} · actual source · {capture.width}px · {capture.dark ? 'dark' : 'light'}</h2>{panel.body}</section>));
        writeFileSync(join(output, `${panel.id}-${capture.dark ? 'dark' : 'light'}-${capture.width}.html`), html);
        await page.setContent(html);
        await page.evaluate(() => document.fonts.ready);
        const path = join(output, `${panel.id}-${capture.dark ? 'dark' : 'light'}-${capture.width}.png`);
        await page.locator('[data-capture-panel]').screenshot({ path });
        console.info(`DV3 SHARE source capture: ${path}`);
        const geometry = await page.evaluate(() => Array.from(document.querySelectorAll(
            '[data-testid$="-copy-link"], [data-testid$="-send-copy"], [data-testid$="-done"], [data-testid$="-name"], [data-testid="profile-environment-add"], [data-testid="saved-secret-access-save"], [data-testid="saved-secret-access-cancel"], [data-testid="saved-secret-create-submit"], [data-testid="saved-secret-create-cancel"], [data-testid="session-public-link-create"], [data-testid="session-public-link-mutation-error"]',
        )).map(element => {
            const { x, y, width, height } = element.getBoundingClientRect();
            const label = Array.from(element.querySelectorAll('div,span')).filter(node =>
                node.childElementCount === 0 && node.textContent?.trim()).at(-1) ?? element;
            return { testID: element.getAttribute('data-testid'), x, y, width, height,
                fontSize: getComputedStyle(label).fontSize };
        }));
        if (geometry.length) console.info(`DV3 SHARE geometry ${panel.id}: ${JSON.stringify(geometry)}`);
        writeFileSync(join(output, `${panel.id}-${capture.dark ? 'dark' : 'light'}-${capture.width}.geometry.json`), JSON.stringify(geometry, null, 2));
    };
    const onlyCollaboration = process.env.DV3_SHARE_CAPTURE_PANEL === 'collaboration';
    if (!onlyCollaboration) {
    console.info(`DV4 SHARE profile Agent fixture: ${getEnabledAgentIds({ backendEnabledByTargetKey: storage.getState().settings.backendEnabledByTargetKey }).length} enabled Agents`);
    for (const document of [{ kind: 'workflow-definition.v1', name: 'Release review', subtitle: '3 steps', id: 'workflow' },
        { kind: 'role.v1', name: 'Code reviewer', subtitle: 'Default agent · Session', id: 'role' },
        { kind: 'work-board.v1', name: 'Release workspace', subtitle: undefined, id: 'board' },
        { kind: 'launch-profile.v1', name: reviewProfile.name, subtitle: getProfileSubtitle({ profile: { ...reviewProfile, compatibility: {} },
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: storage.getState().settings.backendEnabledByTargetKey }),
            strings: getDefaultProfileListStrings(getEnabledAgentIds({ backendEnabledByTargetKey: storage.getState().settings.backendEnabledByTargetKey })) }), id: 'profile' }]) {
        showDocumentShareSheet({ artifactId: document.id, kind: document.kind, name: document.name, subtitle: document.subtitle });
        const chrome = capture.chrome;
        if (!chrome) throw new Error('Document share modal supplied no chrome');
        const adapter = { ...createDocumentShareAdapter({ artifactId: document.id, kind: document.kind, grants: [], loading: false,
            readOnly: false, retryContent: noop, linkPath: `/documents/${document.id}`, sendCopy: noop }),
            publicLink: { stateLabel: t('common.off'), onOpen: noop } };
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><ModalCardFrame title={chrome.title} subtitle={chrome.subtitle}
            presentation={capture.width < 600 ? 'sheet' : 'card'} sheetBottomInset={capture.width < 600 ? 24 : 0}
            dimensions={{ width: 560, maxHeightRatio: 0.92 }} onClose={noop} testID={`${document.id}-modal`}>
            <ShareSheet model={model} actions={actions} adapter={adapter} presentation="full" onRequestClose={noop} testID={`${document.id}-share`} />
        </ModalCardFrame>{document.id === 'board' ? <BoardReadProbe /> : null}</InjectedAuthProvider>);
        if (document.id === 'board') {
            try { await vi.waitFor(() => expect(sourceText(screen.tree.toJSON())).toContain(t('boards.meta.items', { count: 11 }))); }
            catch { prerequisites.push(`Board subtitle has not loaded its 1 picked + 10 filtered members; read state: ${JSON.stringify(boardReadState)}; HTTP requests: ${home.requests.map(row => row.path).join(', ')}`); }
        }
        await settle(screen);
        await emit({ id: `share-${document.id}`, body: hostTree(screen.tree.toJSON()) });
        await screen.unmount();
    }
    const sessionModel: SessionAccessEditorModel = { revision: 1, accessMode: 'editable',
        content: { phase: 'ready', hasLastAcknowledgedSnapshot: true }, owner: model.owner,
        grants: model.grants.map(row => ({ ...row, permissionDelegation: { kind: 'editable', value: false }, requiredByTeamPolicy: false })),
        directory: model.directory, summary: { label: 'Happier Team', accessibilityLabel: 'Happier Team', requiredByTeamPolicy: false },
        context: { primaryTeamId: 'happier-team', options: [{ teamId: null, label: 'Private' }, { teamId: 'happier-team', label: 'Happier Team' }] },
        encryption: { statusKey: 'needs_attention', summaryLabel: '1 pending', accessibilityLabel: '1 pending', actionLabel: 'Prepare now',
            showAllLabel: 'Show all people', recipientsView: 'exceptions', recipients: { rows: [{ recipientAccountId: 'collaborator',
                state: 'pending', label: 'Maya Chen', stateLabel: 'Encrypted access pending', accessibilityLabel: 'Maya Chen, encrypted access pending',
                actionLabel: 'Prepare now' }], hasMore: false, loading: false } } };
    const sessionActions: SessionAccessEditorActions = { ...actions, retryContent: noop, setPermissionDelegation: noop,
        setContext: noop, confirmContext: noop, cancelContext: noop, clearAccess: noop, prepareAccess: noop,
        toggleAllRecipients: noop, loadMoreRecipients: noop };
    const sessionAdapter = { ...createSessionShareSheetAdapter({ model: sessionModel, actions: sessionActions, linkPath: '/session/release-review' }),
        publicLink: { stateLabel: t('common.off'), onOpen: noop } };
    const session = await renderScreen(<ModalCardFrame title="Share Release workspace" subtitle="Session · Claude · MacBook Pro"
        presentation={capture.width < 600 ? 'sheet' : 'card'} sheetBottomInset={capture.width < 600 ? 24 : 0}
        dimensions={{ width: 560, maxHeightRatio: 0.92 }} onClose={noop} testID="session-modal">
        <ShareSheet model={{ ...model, grants: sessionModel.grants }} actions={sessionActions} adapter={sessionAdapter}
            presentation="full" onRequestClose={noop} testID="session-share" />
    </ModalCardFrame>);
    await settle(session);
    await emit({ id: 'share-session', body: hostTree(session.tree.toJSON()) });
    await session.unmount();
    if (!['baseline', 'secrets'].includes(process.env.DV3_SHARE_CAPTURE_PANEL ?? '')) {
        await getServerFeaturesSnapshot({ serverId: scope.serverId, force: true });
        const publicLink = await renderScreen(<InjectedAuthProvider credentials={credentials}><PublicLinkCapture /></InjectedAuthProvider>);
        const publicRow = publicLink.findByTestId('public-link-share:document-share-public-link');
        if (!publicRow) throw new Error('Public-link row is absent from the real source sheet');
        await act(async () => { publicRow.props.onClick(new MouseEvent('click', { bubbles: true })); });
        await vi.waitFor(() => expect(publicLink.findByTestId('session-public-link-create')).not.toBeNull());
        await settle(publicLink);
        await emit({ id: 'document-public-link-expanded', body: hostTree(publicLink.tree.toJSON()) });
        await act(async () => { publicLink.findByTestId('session-public-link-create')!.props.onClick(new MouseEvent('click', { bubbles: true })); });
        await vi.waitFor(() => expect(publicLink.findByTestId('session-public-link-options-create')).not.toBeNull());
        await settle(publicLink);
        await emit({ id: 'document-public-link-options', body: hostTree(publicLink.tree.toJSON()) });
        await act(async () => { publicLink.findByTestId('session-public-link-options-create')!.props.onClick(new MouseEvent('click', { bubbles: true })); });
        await vi.waitFor(() => expect(publicLink.findByTestId('session-public-link-mutation-error')).not.toBeNull());
        expect(publicLink.findByTestId('session-public-link-options-create')).not.toBeNull();
        await settle(publicLink);
        await emit({ id: 'document-public-link-refusal', body: hostTree(publicLink.tree.toJSON()) });
        await publicLink.unmount();
    }
    capture.pathname = '/settings/roles/release-reviewer';
    const roles = await renderScreen(<div className="collection-scene">
        {capture.width >= 600 ? <SettingsPageHeader title={t('roles.rail.label')} description={t('roles.settings.description')} /> : null}
        <HappierListDetailLayout minListWidth={320} minDetailWidth={480} preferredListRatio={0} gap={0}
            list={layout => layout?.mode === 'split' ? <RoleCollectionRail /> : null} detailActive stackedPane="detail"
            detail={<RoleDetailScreen target={{ kind: 'role', roleId: 'release-reviewer' }} />} />
    </div>);
    await vi.waitFor(() => expect(roles.findByTestId('settings.roles.detail.release-reviewer')).not.toBeNull());
    await settle(roles);
    await emit({ id: 'roles', body: hostTree(roles.tree.toJSON()) });
    await roles.unmount();
    if (capture.width < 600) {
        const rail = await renderScreen(<><SettingsPageHeader title={t('roles.rail.label')} description={t('roles.settings.description')} /><RoleCollectionRail /></>);
        await settle(rail);
        await emit({ id: 'roles-list', body: hostTree(rail.tree.toJSON()) });
        await rail.unmount();
    }
    capture.pathname = '/settings/profiles/new';
    const profile = await renderScreen(<NavigationTitleChromeProvider showsTitle={capture.width < 600}>
        <div className="collection-scene"><HappierListDetailLayout minListWidth={320} minDetailWidth={480} preferredListRatio={0} gap={0}
            list={layout => layout?.mode === 'split' ? <ProfileCollectionRail /> : null} detailActive stackedPane="detail"
            detail={<ProfileDetailScreen target={{ kind: 'draft', cloneFrom: 'review-profile' }} />} /></div>
    </NavigationTitleChromeProvider>);
    await settle(profile);
    const headerRight = capture.header.headerRight;
    const header = capture.width < 600 && typeof headerRight === 'function'
        ? await renderScreen((headerRight as () => React.ReactNode)()) : null;
    await emit({ id: 'profile-authoring', body: <>{header ? hostTree(header.tree.toJSON()) : null}{hostTree(profile.tree.toJSON())}</> });
    await profile.unmount();
    await header?.unmount();
    if (capture.width < 600) {
        const rail = await renderScreen(<ProfileCollectionRail />);
        await settle(rail);
        await emit({ id: 'profile-list', body: hostTree(rail.tree.toJSON()) });
        await rail.unmount();
    }
    const access = await renderScreen(<SavedSecretAccessEditor target={{ kind: 'shared', entry: secret }} scope={scope}
        onClose={noop} onSaved={async () => {}} />);
    await vi.waitFor(() => expect(access.findByTestId('saved-secret-access-candidate-account:collaborator')).not.toBeNull());
    await settle(access);
    await emit({ id: 'secret-access-clean', body: hostTree(access.tree.toJSON()) });
    const candidate = access.findByTestId('saved-secret-access-candidate-account:collaborator');
    await act(async () => { candidate!.props.onClick(new MouseEvent('click', { bubbles: true })); });
    await settle(access);
    await emit({ id: 'secret-access-changed', body: hostTree(access.tree.toJSON()) });
    await access.unmount();
    const createSecret = await renderScreen(<SavedSecretCreateEditor scope={scope} approvalPending={false}
        requestApproval={noop} onCancel={noop} onCreated={noop} />);
    await vi.waitFor(() => expect(createSecret.findByTestId('saved-secret-access-candidate-account:collaborator')).not.toBeNull());
    await settle(createSecret);
    await emit({ id: 'secret-create', body: hostTree(createSecret.tree.toJSON()) });
    await createSecret.unmount();
    capture.pathname = '/settings/secrets';
    const secrets = await renderScreen(<SecretsSettingsPage personalSecrets={[]} sharedEntries={[{ ...secret, encryptionMode: 'e2ee' }]}
        corruptEntries={[]} resolveSharedReference={ref => ({ ref, kind: 'shared_resource', status: 'ready',
            entry: secret, secret: null, revision: secret.revision, fingerprint: null })} sharedCatalogStale={false}
        onRenamePersonal={async () => true} onRotatePersonal={async () => true} onDeletePersonal={async () => true}
        onMakeSharedHomeManaged={noop} sharedMutationsDisabled={false} approvalId={null} onAdd={noop} onCancelAdd={noop}
        createEditor={null} accessEditor={{ key: secret.ref, element: null }} />);
    await settle(secrets);
    await emit({ id: 'secrets-page', body: hostTree(secrets.tree.toJSON()) });
    await secrets.unmount();
    const navigation = await renderScreen(<div style={{ display: 'flex', height: 1600, maxWidth: 320 }}><SettingsSidebar /></div>);
    await settle(navigation);
    await emit({ id: 'settings-navigation', body: hostTree(navigation.tree.toJSON()) });
    await navigation.unmount();
    const shell = await renderScreen(<div style={{ display: 'flex', height: 1000 }}>
        <AppShellMaterialFrame showChrome={capture.width >= 600} dragEnabled={false} leftOffsetPx={384} sidebarWidth={320}
            titleStrip={capture.width >= 600 ? <View style={{ height: 44 }} /> : null} rail={null}
            column={capture.width >= 600 ? <SettingsSidebar /> : null} peek={null}>
            <SettingsPageHeader title={t('roles.rail.label')} description={t('roles.settings.description')} />
            <RoleDetailScreen target={{ kind: 'role', roleId: 'release-reviewer' }} />
        </AppShellMaterialFrame>
    </div>);
    await vi.waitFor(() => expect(shell.findByTestId('settings.roles.detail.release-reviewer')).not.toBeNull());
    await settle(shell);
    await emit({ id: 'settings-shell', body: hostTree(shell.tree.toJSON()) });
    await shell.unmount();
    const homeChooser = await renderScreen(<div style={{ display: 'flex', height: 700 }}>
        <SessionInvalidLinkFallback sessionId="qa-unresolved" homeChoice="unknown" />
    </div>);
    await settle(homeChooser);
    await emit({ id: 'home-chooser', body: hostTree(homeChooser.tree.toJSON()) });
    await homeChooser.unmount();
    const accountHomes = await renderScreen(<InjectedAuthProvider credentials={credentials}><ConnectionStatusControl variant="page" /></InjectedAuthProvider>);
    await settle(accountHomes);
    await emit({ id: 'account-homes', body: hostTree(accountHomes.tree.toJSON()) });
    await accountHomes.unmount();
    const switches = await renderScreen(<div><Switch value onValueChange={noop} accessibilityLabel="On switch" testID="switch-on" />
        <Switch value={false} onValueChange={noop} accessibilityLabel="Off switch" testID="switch-off" /></div>);
    await emit({ id: 'switches', body: hostTree(switches.tree.toJSON()) });
    await switches.unmount();
    }
    if (onlyCollaboration) {
        // The real app entry publishes Sync's singleton; conversations consume that runtime.
        await import('@/sync/syncEngine');
        await getServerFeaturesSnapshot({ serverId: scope.serverId, force: true });
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        storage.getState().applyProfileForScope(scope, { ...profileDefaults, id: scope.accountId,
            timestamp: 1, firstName: 'Leeroy', lastName: 'Brun', username: 'leeroy' });
        storage.setState(state => ({ sessionListRowsByServerId: { ...state.sessionListRowsByServerId,
            [scope.serverId]: { release: createSessionListRenderableSessionFixture({ id: 'release',
                responsibleAccountId: null, responsibleAccount: null, metadataLayoutVersion: 1 }) } } }));
        const collaboration = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppPaneProvider>
            <div style={{ display: 'flex', height: 800, maxWidth: 600 }}>
                <SessionCollaborationSurface target={{ serverId: scope.serverId, sessionId: 'release' }} />
            </div>
        </AppPaneProvider></InjectedAuthProvider>);
        await vi.waitFor(() => expect(collaboration.findByTestId('session-collaboration-access-card')).not.toBeNull());
        await vi.waitFor(() => expect(collaboration.findByTestId('session-collaboration-invite-action')).not.toBeNull());
        await settle(collaboration);
        await emit({ id: 'session-collaboration', body: hostTree(collaboration.tree.toJSON()) });
        const card = collaboration.findByTestId('session-collaboration-access-card');
        await act(async () => { card!.props.onClick(new MouseEvent('click', { bubbles: true })); });
        await vi.waitFor(() => expect(collaboration.findByTestId('session-collaboration-share-panel')).not.toBeNull());
        await vi.waitFor(() => expect(collaboration.findByTestId('session-access-editor:collaboration:session-access-candidate-account:collaborator')).not.toBeNull());
        await settle(collaboration);
        await emit({ id: 'session-collaboration-share', body: hostTree(collaboration.tree.toJSON()) });
        const publicRow = collaboration.findByTestId('session-access-editor:collaboration:session-access-public-link');
        await act(async () => { publicRow!.props.onClick(new MouseEvent('click', { bubbles: true })); });
        await vi.waitFor(() => expect(collaboration.findByTestId('session-public-link-create')).not.toBeNull());
        await settle(collaboration);
        await emit({ id: 'session-collaboration-public-link', body: hostTree(collaboration.tree.toJSON()) });
        console.info(`DV3 Collaboration HTTP: ${JSON.stringify(collaborationBoundary.requests.map(row => ({ path: row.path, method: row.method, body: row.body })))}`);
        await collaboration.unmount();
    }
    const body = renderToStaticMarkup(<main>{panels.map(panel => <section key={panel.id} id={panel.id} data-capture-panel={panel.id}>
        <h2>{panel.id} · actual source · {capture.width}px · {capture.dark ? 'dark' : 'light'}</h2>{panel.body}</section>)}</main>);
    const aggregateName = `${process.env.DV3_SHARE_CAPTURE_PANEL ? `${process.env.DV3_SHARE_CAPTURE_PANEL}-` : ''}${capture.dark ? 'dark' : 'light'}-${capture.width}`;
    writeFileSync(join(output, `${aggregateName}.html`), documentHtml(body));
    await page.setContent(documentHtml(body));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(output, `${aggregateName}.png`), fullPage: true });
    for (const panel of panels) await page.locator(`[data-capture-panel="${panel.id}"]`).screenshot({
        path: join(output, `${panel.id}-${capture.dark ? 'dark' : 'light'}-${capture.width}.png`) });
    expect(prerequisites).toEqual([]);
    } finally { disposeHome?.(); await page.close(); await browser.close(); }
}, 120_000);

import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import * as React from 'react';
import { openChatWithFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { Platform, View } from 'react-native';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { COMMAND_SURFACE_DETAIL_PANE, type CommandSurfaceLayout } from '@/modal/components/card/commandSurfaceCard';
import { useDeviceType } from '@/utils/platform/responsive';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { isMemoryDocumentSearchHitV1, isMemoryExternalTranscriptSearchHitV1, type MemorySearchCorpusV1, type MemorySearchHitV1 } from '@happier-dev/protocol/memory/memorySearch';
import { normalizeMemorySearchSessionId } from '@/sync/domains/memory/applyMemorySearchSessionEligibility';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { usePluginUiClientExecutableRegistrationRevision } from '@/components/plugins/reactNative/clientExecutableContributions';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { Command } from '@/components/appShell/commandPalette/types';
import { Modal } from '@/modal';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { useResolvedSettingsPageCatalog } from '@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog';
import type { ResolvedSettingsPageNode } from '@/components/settings/catalog/types';
import { buildSettingsSearchRows, indexSettingsSearchPages } from '@/components/settings/shell/settingsSearchRows';
import {
    SelectionList,
    createDefaultDynamicSectionCache,
    type SelectionListDynamicSectionCache,
    type SelectionListOption,
    type SelectionListFilter,
    type SelectionListInputBehavior,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import {
    useAllMachines,
    useAllSessions,
    useSessionListRowsByServerId,
    useSessionOrganizationProjection,
} from '@/sync/store/hooks';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { areServerAccountScopesEqual, createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { ensureSessionMetadataInventoryForServerAccountScope } from '@/sync/domains/session/fetchSessionMetadataInventoryForServerAccountScope';
import { useWorkspaceRefs, storage } from '@/sync/domains/state/storage';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import {
    useServerCredentialAccountScopes,
    type ServerCredentialAccountScopeBinding,
} from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { searchConversationsForAccount } from '@/sync/ops/searchConversations';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { describeConversationSearchCoverage } from './conversationSearchCoverage';
import { openConversationSearchResult } from '@/sync/ops/openConversationSearchResult';
import { useConversationSearch } from '@/sync/domains/search/useConversationSearch';
import { hasConversationSearchScanFallback } from '@/sync/domains/search/searchConversations';
import {
    useMemorySearchProvider,
} from '@/sync/domains/memory/useMemorySearchProvider';
import {
    captureMemorySearchSessionReadAuthority,
    readMemorySearchSessionForServerScope,
} from '@/sync/domains/memory/hydrateMemorySearchSessionTargets';
import { searchWorkspaceFiles, workspaceFileSearchCache, WorkspaceFileSearchUnavailableError } from '@/sync/domains/workspaces/files/workspaceFileSearch';
import { searchWorkspaceFileContents } from '@/sync/domains/workspaces/files/workspaceFileContentSearch';
import { useWorkspaceReplace, type WorkspaceReplaceMatcher } from '@/sync/domains/workspaces/files/workspaceFileReplace';
import { unsavedWorkspaceFilePaths } from '@/components/appShell/panes/details/workspace/detailsTabChrome';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { useReplaceUndoOnClose } from './replace/useReplaceUndoOnClose';
import { buildReplaceReviewSections, REPLACE_OPTION_PREFIX, ReplaceField, ReplaceFooterAction, ReplaceResultSummary } from './replace/replaceReview';
import { boundedReplyHints } from './searchBoundedReplyHints';
import { parseSearchFileTarget } from '@/utils/url/sessionFileDeepLink';
import { isAbsoluteLocalPath, resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { searchWorkspaceCommits } from '@/scm/search/searchWorkspaceCommits';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { findWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { isWorkspaceScopeReachable } from '@/sync/domains/workspaces/workspaceReachability';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { isSessionContentUnsettled } from '@/sync/domains/session/encryptedContentAvailability';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';
import { Icon } from '@/components/ui/icons/Icon';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { t } from '@/text';
import { transcriptSearchUnavailableHint } from './transcriptSearchUnavailableHint';
import { presentCommitSearchFailure, presentContentSearchError, workspaceFolderMissingFailure } from './universalSearchMachineFailures';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import {
    buildCanonicalSessionListPrimarySearchText,
    buildCanonicalSessionListSearchText,
} from '@/components/sessions/shell/useSessionListSearchTextByKey';
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { sessionTagKey } from '@/components/sessions/shell/sessionTagUtils';
import type { TerminalJumpTarget } from '@/components/sessions/terminal/jump/terminalJumpTarget';
import { useTerminalJumpStep } from '@/components/sessions/terminal/jump/useTerminalJumpStep';
import { useTerminalJumpScopeChrome } from '@/components/sessions/terminal/jump/useTerminalJumpScopeChrome';

import { activateUniversalSearchResult } from './activateUniversalSearchResult';
import { useWorkspaceFileOpener } from '@/components/workspaces/files/useWorkspaceFileOpener';
import {
    buildUniversalSearchSections,
    EXTERNAL_CONVERSATION_SEARCH_OPTION_ID,
    ALL_FILE_MATCHES_OPTION_ID,
    MORE_FILES_OPTION_ID,
    FILE_CONTENT_FOLDER_OPTION_PREFIX,
    findCommandForOptionId,
    type UniversalSearchFolderSuggestion,
    type UniversalSearchProjectEntity,
    type UniversalSearchSessionEntity,
    type UniversalSearchSettingsPageEntity,
    type UniversalSearchSource,
} from './buildUniversalSearchSections';
import { ExternalConversationSearchResults, type ExternalConversationSearchResultsProps } from './ExternalConversationSearchResults';
import { buildPluginSearchProviderSections, type PluginSearchActivationOutcome } from './pluginSearchProviderSections';
import {
    buildUniversalSearchScopeKey,
    buildUniversalSearchSessionTitleKey,
    buildUniversalSearchOptionId,
    UNIVERSAL_SEARCH_SOURCE_IDS,
    UNIVERSAL_SEARCH_PAGE_SIZE,
    type UniversalSearchResult,
} from './universalSearchResult';
import { UniversalSearchNativeHost } from './native/UniversalSearchNativeHost';
import { runUniversalSearchActivation } from './runUniversalSearchActivation';
import { isUniversalSearchTargetCurrent } from './isUniversalSearchTargetCurrent';
import { prepareUniversalSearchResult } from './prepareUniversalSearchResult';
import { buildUniversalSearchWorkspaceFileResults } from './workspaceFileSearchResults';
import { useQuickOpenFileSources } from '@/components/workspaces/files/useQuickOpenEmptyState';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { resolveOpenDetailsFilePath } from '@/components/workspaces/files/resolveOpenDetailsFilePath';
import { createWorkspaceFileSearchIndex, normalizeFileSearchText, rankFileSearchResults, matchWorkspaceFileNames } from '@/sync/domains/workspaces/files/workspaceFileSearchMatcher';
import { selectRecentWorkspaceFiles, workspacePathToFileSearchItem } from '@/sync/domains/workspaces/files/recentWorkspaceFiles';
import { resolveWorkspaceFileQueryLimit, resolveWorkspaceFileSearchPageAvailability, type WorkspaceFileQueryPaging } from '@/sync/domains/workspaces/files/workspaceFileSearchPaging';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { createWorkspaceSymbolSearchSource, type WorkspaceSymbolSearchInput } from './workspaceSymbolSearchSource';
import { useOpenProject } from '@/components/projects/useOpenProject';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import {
    areServerProfileIdentifiersEquivalent,
    listServerProfiles,
    resolveServerProfileScopeId,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import {
    canonicalizeUniversalSearchScopeSeed,
    type UniversalSearchScopeSeed,
    type UniversalSearchSourceFocus,
} from './UniversalSearchRuntimeContext';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { Typography } from '@/constants/Typography';
import {
    buildUniversalSearchScopeChoices,
    buildUniversalSearchScopeKeyFromSeed,
} from './universalSearchScope';

const styles = StyleSheet.create(() => ({
    root: { flex: 1, minHeight: 0, width: '100%' },
}));

type PendingActivation = () => Promise<unknown>;
const NO_SESSION_ADDRESSES: readonly SessionAddress[] = [];
const MEMORY_SEARCH_CORPORA: readonly MemorySearchCorpusV1[] = ['documents', 'sessions', 'external_transcripts'];

function useUniversalSearchDynamicCache(
    scope: UniversalSearchScopeSeed,
    credentialBinding: ServerCredentialAccountScopeBinding | null,
    pluginAccountLifetime: ActiveServerAccountScopeLifetime | null,
    pluginAccountLifetimeRevision: number,
): SelectionListDynamicSectionCache {
    const key = `${scope.serverId ?? ''}\u0000${scope.accountId ?? ''}\u0000${credentialBinding?.revision ?? -1}\u0000${pluginAccountLifetimeRevision}`;
    const cache = React.useMemo(() => createDefaultDynamicSectionCache(), [key]);
    React.useEffect(() => {
        const credentialRetirement = credentialBinding?.onRetire(() => cache.clear()) ?? null;
        const pluginRetirement = pluginAccountLifetime?.onRetire(() => cache.clear()) ?? null;
        return () => {
            credentialRetirement?.dispose();
            pluginRetirement?.dispose();
            cache.clear();
        };
    }, [cache, credentialBinding, key, pluginAccountLifetime]);
    return cache;
}

function useCurrentPluginAccountLifetime(): Readonly<{
    lifetime: ActiveServerAccountScopeLifetime | null;
    revision: number;
}> {
    const [, renderRetirement] = React.useReducer((value: number) => value + 1, 0);
    const lifetime = captureActiveServerAccountScopeLifetime();
    const identity = React.useRef({ lifetime, revision: 0 });
    if (identity.current.lifetime !== lifetime) {
        identity.current = { lifetime, revision: identity.current.revision + 1 };
    }
    React.useEffect(() => {
        if (!lifetime) return;
        const retirement = lifetime.onRetire(renderRetirement);
        return () => retirement.dispose();
    }, [lifetime]);
    return { lifetime, revision: identity.current.revision };
}

/** Every catalog page by id, so a settings result stays current only while its page is offered. */
function settingsPageNodesById(nodes: readonly ResolvedSettingsPageNode[]): ReadonlyMap<string, ResolvedSettingsPageNode> {
    const result = new Map<string, ResolvedSettingsPageNode>();
    const visit = (items: readonly ResolvedSettingsPageNode[]) => {
        for (const item of items) {
            result.set(item.id, item);
            if (item.children) visit(item.children);
        }
    };
    visit(nodes);
    return result;
}

function memoryHitResult(hit: MemorySearchHitV1, serverId: string, accountId: string, title: string, query: string): UniversalSearchResult {
    const sessionId = normalizeMemorySearchSessionId(hit.sessionId);
    return {
        id: `${sessionId}:${hit.seqFrom}:${hit.seqTo}`,
        scopeKey: buildUniversalSearchScopeKey([accountId, serverId, sessionId, hit.seqFrom, hit.seqTo]),
        sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.transcript,
        kind: 'message',
        title,
        subtitle: hit.summary,
        target: { kind: 'session', serverId, accountId, sessionId, seq: hit.seqFrom,
            find: { query, options: { matchCase: false, regex: false }, target: { kind: 'seq', seq: hit.seqFrom } } },
    };
}

export type UniversalSearchControllerProps = Readonly<{
    commands: readonly Command[];
    /** An imperative modal receives the opener captured by its retained Workspace owner. */
    openWorkspaceFile?: ReturnType<typeof useWorkspaceFileOpener>['open'];
    /** P7/PAGE supplies the existing active document holder; Search never loads a second document. */
    symbols?: WorkspaceSymbolSearchInput;
    initialQuery?: string;
    initialSource?: UniversalSearchSourceFocus;
    /** Open Text in files with the Replace field shown (⌘⇧H). */
    initialReplace?: boolean;
    activeSessionId?: string | null;
    initialScope?: UniversalSearchScopeSeed;
    /** Open in the Terminals scope of this session pane (Jump to a terminal, terminal lab B4). */
    terminalJump?: TerminalJumpTarget;
    presentation: 'modal' | 'route';
    /** The frame the card needs: compact for everything, `detail` while a detail column sits beside the list. */
    onSurfaceLayoutChange?(layout: CommandSurfaceLayout): void;
    onRequestClose(): void;
}>;

function resolveInitialScope(props: Pick<UniversalSearchControllerProps, 'activeSessionId' | 'initialScope'>): UniversalSearchScopeSeed {
    if (props.initialScope) return canonicalizeUniversalSearchScopeSeed(props.initialScope);
    const activeAccountScope = captureActiveServerAccountScopeLifetime()?.scope;
    return canonicalizeUniversalSearchScopeSeed({
        accountId: activeAccountScope?.accountId ?? null,
        serverId: activeAccountScope?.serverId ?? null,
        sessionId: props.activeSessionId ?? null,
        machineId: null,
        rootPath: null,
    });
}

export function UniversalSearchController(props: UniversalSearchControllerProps): React.ReactElement {
    const { theme } = useUnistyles();
    const { open: inheritedOpenFile } = useWorkspaceFileOpener();
    const openFile = props.openWorkspaceFile ?? inheritedOpenFile;
    const deviceType = useDeviceType();
    const textInFilesShortcut = useKeyboardShortcutLabel('search.textInFiles');
    const [scope, setScope] = React.useState<UniversalSearchScopeSeed>(() => resolveInitialScope(props));
    const startsInSymbols = props.initialSource === 'files' && props.initialQuery?.startsWith('@') === true;
    const [query, setQuery] = React.useState(() => startsInSymbols ? props.initialQuery!.slice(1) : props.initialQuery ?? '');
    const [source, setSource] = React.useState<UniversalSearchSourceFocus | undefined>(startsInSymbols ? 'symbols' : props.initialSource);
    const activationGeneration = React.useRef(0);
    const changeQuery = React.useCallback((value: string) => {
        activationGeneration.current += 1;
        if (source === 'files' && value.startsWith('@')) {
            setSource('symbols');
            setQuery(value.slice(1));
        } else setQuery(value);
    }, [source]);
    const requestClose = React.useCallback(() => {
        activationGeneration.current += 1;
        props.onRequestClose();
    }, [props.onRequestClose]);
    const [matchCase, setMatchCase] = React.useState(false);
    const [regex, setRegex] = React.useState(false);
    // Opening Replace explicitly arms the review, including deletion with an empty replacement.
    const [replaceOpen, setReplaceOpen] = React.useState(() => props.initialReplace === true && props.initialSource === 'fileContent');
    const [replacement, setReplacement] = React.useState('');
    const replaceToggledOpen = React.useRef(false);
    const [selectedOptionId, setSelectedOptionId] = React.useState<string | null>(null);
    const [sessionInventoryStatus, setSessionInventoryStatus] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [externalConversationSearch, setExternalConversationSearch] = React.useState<Pick<ExternalConversationSearchResultsProps, 'target' | 'query' | 'machineLabel' | 'accountLifetime'> | null>(null);
    // The Terminals scope (Jump): one session's terminals until the person drops the scope with ⌫
    // on an empty field or the chip's ×, then the ordinary search over everything.
    const [terminalScope, setTerminalScope] = React.useState<TerminalJumpTarget | null>(() => props.terminalJump ?? null);
    const terminalJump = useTerminalJumpStep({ target: terminalScope, query });
    const committedResultRef = React.useRef<UniversalSearchResult | null>(null);
    const committedPluginActivationRef = React.useRef<PendingActivation | null>(null);
    const profilesGeneration = useServerProfilesGeneration();
    const profiles = React.useMemo(() => listServerProfiles(), [profilesGeneration]);
    const credentialBindings = useServerCredentialAccountScopes(profiles.map(resolveServerProfileScopeId));
    const selectedCredentialBinding = scope.serverId
        ? credentialBindings.get(scope.serverId) ?? null
        : null;
    const selectedCredentialIsCurrent = selectedCredentialBinding?.isCurrent() === true
        && selectedCredentialBinding.accountId === scope.accountId;
    React.useEffect(() => {
        if (!externalConversationSearch) return;
        const retirement = externalConversationSearch.accountLifetime.onRetire(() => setExternalConversationSearch(null));
        return () => retirement.dispose();
    }, [externalConversationSearch]);
    React.useEffect(() => {
        if (!scope.serverId || !selectedCredentialBinding || scope.accountId === selectedCredentialBinding.accountId) return;
        setScope((current) => current.serverId === scope.serverId
            ? { ...current, accountId: selectedCredentialBinding.accountId }
            : current);
    }, [scope.accountId, scope.serverId, selectedCredentialBinding]);
    const memoryProvider = useMemorySearchProvider(scope.serverId
        ? { kind: 'exact', serverId: scope.serverId, machineId: scope.machineId }
        : { kind: 'none' }, { corpora: MEMORY_SEARCH_CORPORA, conversationSearch: true });
    const homeCredentialRevision = selectedCredentialBinding?.revision ?? -1;
    const pluginAccount = useCurrentPluginAccountLifetime();
    const dynamicSectionCache = useUniversalSearchDynamicCache(
        scope,
        selectedCredentialBinding,
        pluginAccount.lifetime,
        pluginAccount.revision,
    );
    const navigateToSession = useNavigateToSession();
    const paneContext = useOptionalAppPaneContext();
    const router = useRouter();
    const openProject = useOpenProject();
    const settingsCatalog = useResolvedSettingsPageCatalog();
    const sessions = useAllSessions();
    const sessionListRowsByServerId = useSessionListRowsByServerId();
    const dirtyTargetMachineLists = storage(state => state.machineListByServerId);
    const dirtyTargetMachineListStatus = storage(state => state.machineListStatusByServerId);
    const workspaceRefs = useWorkspaceRefs();
    const canonicalScopeServerId = scope.serverId
        ? resolveServerProfileScopeIdForIdentifier(scope.serverId)
        : null;
    // Results name Sessions from encrypted content: the undecided ones are demanded like visible list rows.
    const undecidedSessions = React.useMemo(() => Object.values(readSessionListRowsForServerId(sessionListRowsByServerId, canonicalScopeServerId) ?? {})
        .filter(row => typeof row.archivedAt !== 'number' && isSessionContentUnsettled(row)
            && (source === undefined || row.id === scope.sessionId))
        .map((row): SessionAddress => ({ serverId: canonicalScopeServerId ?? '', sessionId: row.id })), [canonicalScopeServerId, scope.sessionId, sessionListRowsByServerId, source]);
    useSessionContentDemand(canonicalScopeServerId ? undecidedSessions : NO_SESSION_ADDRESSES, { tag: 'search.hydrateSessionRows', hydrate: 'unsettled' });
    const sessionOrganizationProjection = useSessionOrganizationProjection(canonicalScopeServerId);
    const sessionOrganizationListViewState = React.useMemo(() => buildSessionOrganizationListViewState({
        serverId: canonicalScopeServerId ?? '',
        projection: sessionOrganizationProjection,
    }), [canonicalScopeServerId, sessionOrganizationProjection]);
    const appShellPluginProjection = useAppShellPluginUiProjection();
    const scopedPluginProjectionEnabled = canonicalScopeServerId !== null && scope.machineId !== null;
    const scopedPluginProjection = useScopedPluginUiProjection({
        serverId: canonicalScopeServerId,
        machineId: scope.machineId,
        enabled: scopedPluginProjectionEnabled,
    });
    const appShellProjectionMatchesScope = Boolean(
        canonicalScopeServerId
        && (appShellPluginProjection.serverId == null
            || areServerProfileIdentifiersEquivalent(
                appShellPluginProjection.serverId,
                canonicalScopeServerId,
            )),
    );
    const pluginProjection = !scopedPluginProjectionEnabled && appShellProjectionMatchesScope
        ? appShellPluginProjection
        : scopedPluginProjection;
    const currentUiContextReader = useOptionalCurrentUiContextReader();
    const pluginNavigationBinding = usePluginSurfaceDestinationNavigationBinding();

    const hasSessionDiscoveryQuery = source === undefined && query.trim().length > 0;
    React.useEffect(() => {
        if (
            !hasSessionDiscoveryQuery
            || !scope.serverId
            || !scope.accountId
            || !selectedCredentialIsCurrent
            || !selectedCredentialBinding
        ) {
            setSessionInventoryStatus('idle');
            return;
        }
        const exactAccountScope = createServerAccountScope(scope.serverId, scope.accountId);
        if (!exactAccountScope) {
            setSessionInventoryStatus('error');
            return;
        }
        const controller = new AbortController();
        let current = true;
        setSessionInventoryStatus('loading');
        void ensureSessionMetadataInventoryForServerAccountScope({
            scope: exactAccountScope,
            accountLifetime: selectedCredentialBinding,
            signal: controller.signal,
        }).then(() => {
            if (current && !controller.signal.aborted && selectedCredentialBinding.isCurrent()) {
                setSessionInventoryStatus('ready');
            }
        }).catch((error: unknown) => {
            if (!current || controller.signal.aborted || !selectedCredentialBinding.isCurrent()) return;
            if (error instanceof Error && error.name === 'AbortError') return;
            setSessionInventoryStatus('error');
        });
        return () => {
            current = false;
            controller.abort();
        };
    }, [hasSessionDiscoveryQuery, scope.accountId, scope.serverId, selectedCredentialBinding, selectedCredentialIsCurrent]);

    const machines = useAllMachines();
    const machineNameById = React.useMemo(() => new Map(
        machines.flatMap((machine) => {
            const name = getMachineDisplayName(machine);
            return name ? [[machine.id, name] as const] : [];
        }),
    ), [machines]);
    const machineHomeById = React.useMemo(() => new Map(
        machines.flatMap((machine) => machine.metadata?.homeDir ? [[machine.id, machine.metadata.homeDir] as const] : []),
    ), [machines]);
    const sessionEntities = React.useMemo<readonly UniversalSearchSessionEntity[]>(() => {
        if (!scope.serverId || !scope.accountId || !selectedCredentialIsCurrent) return [];
        const canonicalServerId = canonicalScopeServerId!;
        const rows = readSessionListRowsForServerId(sessionListRowsByServerId, canonicalServerId) ?? {};
        return Object.values(rows).map((session) => {
            const metadata = session.metadata;
            // A no-folder session is a chat, not a project: its private folder is never a label or a scope.
            const withoutFolder = readSessionDirectoryKind(metadata) === 'managed';
            const path = !withoutFolder && typeof metadata?.path === 'string' ? metadata.path : '';
            const machineId = typeof metadata?.machineId === 'string' ? metadata.machineId : '';
            const workspace = path && machineId
                ? findWorkspaceRefByScope(workspaceRefs, { serverId: canonicalServerId, machineId, rootPath: path })
                : null;
            // One quiet meta line: the project, then the machine it runs on ("happier · MacBook Pro").
            const projectLabel = withoutFolder
                ? t('session.folderless.chats')
                : workspace?.label?.trim() || path.split(/[\\/]/).filter(Boolean).pop() || '';
            const subtitle = [projectLabel, machineNameById.get(machineId) ?? ''].filter(Boolean).join(' · ');
            return {
                sessionId: session.id,
                serverId: canonicalServerId,
                accountId: scope.accountId!,
                title: getSessionName(session, canonicalServerId),
                ...(subtitle ? { subtitle } : {}),
                searchText: buildCanonicalSessionListSearchText({
                    sessionId: session.id,
                    renderable: session,
                    tags: (sessionOrganizationListViewState.sessionTagsV1[sessionTagKey(canonicalServerId, session.id)] ?? [])
                        .flatMap((tag) => tag.display.status === 'available' ? [tag.display.value] : []),
                    workspaceDisplayLabel: workspace?.label ?? null,
                }),
                exactSearchText: buildCanonicalSessionListPrimarySearchText({
                    sessionId: session.id,
                    renderable: session,
                    workspaceDisplayLabel: workspace?.label ?? null,
                }),
                updatedAt: session.updatedAt,
            };
        }).sort((a, b) => b.updatedAt - a.updatedAt);
    }, [canonicalScopeServerId, machineNameById, scope.accountId, scope.serverId, selectedCredentialIsCurrent, sessionListRowsByServerId, sessionOrganizationListViewState.sessionTagsV1, workspaceRefs]);
    const sessionNameByTarget = React.useMemo(
        () => new Map(sessionEntities.map((session) => [
            buildUniversalSearchSessionTitleKey(session.accountId, session.serverId, session.sessionId),
            session.title,
        ])),
        [sessionEntities],
    );
    const projects = React.useMemo<readonly UniversalSearchProjectEntity[]>(() => workspaceRefs
        .filter((workspace) => Boolean(scope.serverId && scope.accountId && selectedCredentialIsCurrent)
            && areServerProfileIdentifiersEquivalent(workspace.serverId, scope.serverId))
        .slice()
        .sort((a, b) => (b.lastOpenedAtMs ?? b.createdAtMs) - (a.lastOpenedAtMs ?? a.createdAtMs))
        .map((workspace) => ({
            workspaceRefId: workspace.id,
            serverId: resolveServerProfileScopeIdForIdentifier(workspace.serverId),
            accountId: scope.accountId!,
            machineId: workspace.machineId,
            rootPath: workspace.rootPath,
            title: workspace.label?.trim() || workspace.rootPath.split(/[\\/]/).filter(Boolean).pop() || workspace.rootPath,
            // Where it lives, as session rows say it: the path from the machine's home, then the machine.
            subtitle: [formatPathRelativeToHome(workspace.rootPath, machineHomeById.get(workspace.machineId)),
                machineNameById.get(workspace.machineId)].filter(Boolean).join(' · '),
            lastOpenedAtMs: workspace.lastOpenedAtMs ?? workspace.createdAtMs,
        })), [machineHomeById, machineNameById, scope.accountId, scope.serverId, selectedCredentialIsCurrent, workspaceRefs]);

    const settingsPages = React.useMemo(() => indexSettingsSearchPages(settingsCatalog.tree), [settingsCatalog.tree]);
    const settingsById = React.useMemo(() => settingsPageNodesById(settingsCatalog.tree), [settingsCatalog.tree]);
    // One Settings group: the pages the query names, then individual settings, projected by the
    // same row owner as the settings rail (title + "Page › Section").
    const searchSettingsPages = React.useCallback((value: string): UniversalSearchSettingsPageEntity[] => {
        const { pageRows, settingRows } = buildSettingsSearchRows(settingsCatalog.search(value), settingsPages);
        return [...pageRows, ...settingRows].map((row) => ({
            id: row.kind === 'setting' ? `setting:${row.id}` : row.id,
            route: row.route,
            title: row.title,
            ...(row.subtitle ? { subtitle: row.subtitle } : {}),
        }));
    }, [settingsCatalog, settingsPages]);

    const conversationScopeKey = buildUniversalSearchScopeKeyFromSeed(scope);
    const transcript = React.useMemo<UniversalSearchSource>(() => {
        if (!canonicalScopeServerId || !scope.accountId) return { status: 'absent' };
        if (!selectedCredentialIsCurrent || !memoryProvider.queryAvailable || !memoryProvider.conversation) {
            return { status: 'unavailable', resolverKey: `transcript:${conversationScopeKey}:${homeCredentialRevision}`,
                hint: transcriptSearchUnavailableHint(memoryProvider.unavailableReason) };
        }
        const providers = memoryProvider.conversation;
        return {
            status: 'ready',
            resolverKey: `conversations:${conversationScopeKey}:${homeCredentialRevision}:${JSON.stringify(providers)}`,
            resolve: async (value, signal, onProgress) => {
                const lifetime = selectedCredentialBinding;
                if (!lifetime?.isCurrent() || lifetime.accountId !== scope.accountId) return [];
                const project = (response: Awaited<ReturnType<typeof searchConversationsForAccount>>) => {
                    const results = response.hits.flatMap<UniversalSearchResult>(row => {
                        if (row.mode !== 'indexed') return [];
                        const hit = row.hit;
                        if (isMemoryExternalTranscriptSearchHitV1(hit)) {
                            if (!row.machineId) return [];
                            return [{ id: buildUniversalSearchScopeKey([row.machineId, hit.source.sourceKey, hit.source.nativeSessionId, hit.sourceItemId]),
                                scopeKey: conversationScopeKey, sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.transcript, kind: 'externalConversation',
                                // An Agent's own conversation has no Happier title: the Agent names the row, the match says why.
                                title: resolveAgentCatalogTitle(hit.source.agentId),
                                conversation: { snippet: hit.summary, query: value, agentId: hit.source.agentId,
                                    machineLabel: machineNameById.get(row.machineId) ?? row.machineId, atMs: hit.createdAtToMs },
                                target: { kind: 'externalConversation', serverId: canonicalScopeServerId,
                                    accountId: lifetime.accountId, machineId: row.machineId, agentId: hit.source.agentId,
                                    sourceKey: hit.source.sourceKey, candidate: { remoteSessionId: hit.source.nativeSessionId, updatedAtMs: hit.createdAtToMs },
                                    sourceItemId: hit.sourceItemId, query: value } }];
                        }
                        if (isMemoryDocumentSearchHitV1(hit)) {
                            const topic = typeof hit.location === 'object' ? hit.location.title : null;
                            const location = typeof hit.location === 'object' ? hit.location.type : hit.location;
                            const identity = [hit.ref.serverId, hit.ref.artifactId, location, topic, hit.factId];
                            return [{ id: buildUniversalSearchScopeKey(identity),
                                scopeKey: buildUniversalSearchScopeKey([lifetime.accountId, canonicalScopeServerId, ...identity]),
                                sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.transcript, kind: 'memoryDocument', title: hit.summary,
                                target: { kind: 'memoryDocument', serverId: canonicalScopeServerId, accountId: lifetime.accountId,
                                    ref: hit.ref, location: hit.location, ...(hit.factId !== undefined ? { factId: hit.factId } : {}) } }];
                        }
                        const freshRow = readSessionListRowsForServerId(storage.getState().sessionListRowsByServerId, canonicalScopeServerId)?.[hit.sessionId];
                        const title = (freshRow ? getSessionName(freshRow, canonicalScopeServerId) : '')
                            || sessionNameByTarget.get(buildUniversalSearchSessionTitleKey(lifetime.accountId, canonicalScopeServerId, hit.sessionId));
                        return [{ ...memoryHitResult(hit, canonicalScopeServerId, lifetime.accountId,
                            title && title !== hit.summary ? title : t('sessionsList.sessionFallbackLabel'), value),
                            conversation: { snippet: hit.summary, query: value, atMs: hit.createdAtToMs } }];
                    });
                    // Which machines were not fully covered, by name and reason. A machine whose index is off
                    // is only worth saying when every machine was asked; otherwise the Home answers for it.
                    const coverage = describeConversationSearchCoverage({ machines: response.machines, homeStatus: response.homeStatus, failures: response.failures,
                        machineName: (machineId) => machineNameById.get(machineId) ?? machineId,
                        ...(scope.machineScope === 'all' ? {} : { omit: ['disabled-by-settings'] as const }) });
                    const documentHint = response.machines.some(machine => machine.documents === 'ready') ? null
                        : response.machines.some(machine => machine.documents === 'pending') ? t('memorySearchSettings.status.indexing')
                        : t('memoryContext.memory.documentSearchUnavailable');
                    return { results, resultHint: [coverage, documentHint].filter(Boolean).join(' · ') };
                };
                const response = await searchConversationsForAccount({
                    query: { v: 1, query: value, scope: { type: 'global' }, mode: 'auto', corpora: [...MEMORY_SEARCH_CORPORA], maxResults: 20 },
                    accountLifetime: lifetime, providers, mode: 'indexed', signal,
                    onProgress: onProgress ? response => {
                        if (!signal.aborted && lifetime.isCurrent()) onProgress(project(response));
                    } : undefined,
                    ...(scope.machineScope !== 'all' && (scope.machineId || memoryProvider.daemonTarget)
                        ? { machineIds: [scope.machineId ?? memoryProvider.daemonTarget!.machineId] } : {}),
                });
                if (signal.aborted || !lifetime.isCurrent()) return [];
                return project(response);
            },
        };
    }, [canonicalScopeServerId, conversationScopeKey, homeCredentialRevision, machineNameById, memoryProvider, scope.accountId, scope.machineId, scope.machineScope,
        selectedCredentialBinding, selectedCredentialIsCurrent, sessionNameByTarget]);
    const activeSession = React.useMemo(
        () => scope.serverId && scope.accountId && pluginAccount.lifetime?.isCurrent() === true
            && areServerAccountScopesEqual(
                pluginAccount.lifetime.scope,
                createServerAccountScope(scope.serverId, scope.accountId),
            )
            ? sessions.find((session) => session.id === scope.sessionId
            && Boolean(scope.serverId)
            && areServerProfileIdentifiersEquivalent(session.serverId, scope.serverId)
            && readSessionListRowsForServerId(sessionListRowsByServerId, scope.serverId)?.[session.id] !== undefined) ?? null
            : null,
        [pluginAccount.lifetime, scope.accountId, scope.serverId, scope.sessionId, sessionListRowsByServerId, sessions],
    );
    const workspaceScope = React.useMemo(() => {
        if (scope.serverId && scope.machineId && scope.rootPath) {
            return { serverId: scope.serverId, machineId: scope.machineId, rootPath: scope.rootPath };
        }
        if (!activeSession) return null;
        const serverId = resolveServerProfileScopeIdForIdentifier(scope.serverId);
        const accountId = scope.accountId?.trim() ?? '';
        if (!serverId || !accountId) return null;
        const target = readMachineControlTargetForSession({
            serverId,
            accountId,
            sessionId: activeSession.id,
        });
        if (!target || !serverId || !target.machineId || !target.basePath) return null;
        return { serverId, machineId: target.machineId, rootPath: target.basePath };
    }, [activeSession, scope.accountId, scope.machineId, scope.rootPath, scope.serverId]);
    const workspaceResolverKey = workspaceScope
        ? `${workspaceScope.serverId}:${workspaceScope.machineId}:${workspaceScope.rootPath}:${selectedCredentialBinding?.accountId ?? ''}:${selectedCredentialBinding?.revision ?? -1}`
        : '';
    React.useEffect(() => {
        activationGeneration.current += 1;
        return () => { activationGeneration.current += 1; };
    }, [props.symbols, query, source, workspaceResolverKey]);
    const [filePaging, setFilePaging] = React.useState<WorkspaceFileQueryPaging | null>(null);
    const fileLimit = resolveWorkspaceFileQueryLimit({ scope: workspaceScope, query,
        pageSize: UNIVERSAL_SEARCH_PAGE_SIZE, paging: filePaging })!;
    const loadMoreFiles = React.useCallback(() => setFilePaging(previous => ({ scope: workspaceScope, query,
        pages: previous?.scope === workspaceScope && previous.query === query ? previous.pages + 1 : 2 })), [query, workspaceScope]);
    const workspaceRef = React.useMemo(
        () => workspaceScope ? findWorkspaceRefByScope(workspaceRefs, workspaceScope) : null,
        [workspaceRefs, workspaceScope],
    );
    const workspaceActivationAvailable = Boolean(activeSession || workspaceRef);
    const readSymbolsInput = React.useCallback(() => {
        const input = props.symbols;
        if (!input || !workspaceScope || !selectedCredentialBinding?.isCurrent()
            || selectedCredentialBinding.accountId !== scope.accountId || input.target.accountId !== scope.accountId
            || !input.isCurrent() || !input.accountLifetime.isCurrent()
            || input.accountLifetime.scope.accountId !== input.target.accountId
            || !areServerProfileIdentifiersEquivalent(input.accountLifetime.scope.serverId, workspaceScope.serverId)) return null;
        const workspaceKey = tryBuildWorkspaceCacheKey(workspaceScope);
        if (!workspaceKey || workspaceKey !== tryBuildWorkspaceCacheKey(input.target.scope)) return null;
        const addressed = input.target.workspaceRefId
            ? input.target.workspaceRefId === workspaceRef?.id
            : input.target.sessionId !== null && input.target.sessionId === activeSession?.id;
        return addressed ? input : null;
    }, [activeSession?.id, props.symbols, scope.accountId, selectedCredentialBinding, workspaceRef?.id, workspaceScope]);
    const symbolsInput = readSymbolsInput();
    const paneDetails = React.useMemo(() => {
        const scopeId = activeSession ? createSessionPaneScopeId(activeSession.id, workspaceScope?.serverId)
            : workspaceRef ? buildProjectPaneScopeId(workspaceRef.id, workspaceScope?.serverId) : null;
        const details = scopeId ? paneContext?.state.scopes[scopeId]?.details : null;
        return details ? buildDetailsWorkspaceStateView(details) : null;
    }, [activeSession, paneContext?.state.scopes, workspaceRef, workspaceScope?.serverId]);
    const activeFilePath = React.useMemo(() => symbolsInput ? symbolsInput.target.path : resolveOpenDetailsFilePath(paneDetails), [paneDetails, symbolsInput]);
    const symbolsSource = React.useMemo<UniversalSearchSource>(() => symbolsInput
        ? createWorkspaceSymbolSearchSource(symbolsInput)
        : { status: 'unavailable', resolverKey: `${workspaceResolverKey}|${activeFilePath ?? ''}`,
            // Until the file's language services answer, the line says so for that file (never a bare "Unavailable").
            hint: activeFilePath ? t('universalSearch.quickOpen.symbolsUnavailable', { file: activeFilePath.split('/').at(-1) ?? activeFilePath })
                : t('universalSearch.quickOpen.symbolsNeedFile') },
    [activeFilePath, symbolsInput, workspaceResolverKey]);
    const quickOpenSources = useQuickOpenFileSources({ scope: workspaceScope, sessionId: activeSession?.id, activeFilePath });
    const recentFileResults = React.useMemo(() => workspaceScope && scope.accountId ? buildUniversalSearchWorkspaceFileResults({
        files: quickOpenSources.recent, scope: workspaceScope, accountId: scope.accountId,
        workspaceRefId: workspaceRef?.id ?? null, sessionId: activeSession?.id ?? null,
    }) : [], [activeSession?.id, quickOpenSources.recent, scope.accountId, workspaceRef?.id, workspaceScope]);
    // Changed files keep their +/− wherever they list: Changed in this session and typed results (lab FB2, FB2t).
    const changedFileLines = React.useMemo(() => new Map(quickOpenSources.changed.flatMap(file => file.isComplete !== false
        && typeof file.linesAdded === 'number' && typeof file.linesRemoved === 'number'
        ? [[file.fullPath, { added: file.linesAdded, removed: file.linesRemoved }] as const] : [])), [quickOpenSources.changed]);
    const changedFileResults = React.useMemo(() => workspaceScope && scope.accountId ? buildUniversalSearchWorkspaceFileResults({
        files: quickOpenSources.changed.map(file => workspacePathToFileSearchItem(file.fullPath)),
        scope: workspaceScope, accountId: scope.accountId, workspaceRefId: workspaceRef?.id ?? null, sessionId: activeSession?.id ?? null,
        changes: changedFileLines,
    }) : [], [activeSession?.id, changedFileLines, quickOpenSources.changed, scope.accountId, workspaceRef?.id, workspaceScope]);
    const emptyFileSelection = React.useRef('');
    React.useEffect(() => {
        const basis = `${workspaceResolverKey}|${source ?? ''}|${query}`;
        if (emptyFileSelection.current === basis) return;
        if (source !== 'files' || query.trim()) { emptyFileSelection.current = basis; return; }
        const selected = [...recentFileResults, ...changedFileResults].find(result => result.target.kind === 'workspaceFile'
            && result.target.path === quickOpenSources.defaultSelectedPath);
        if (!selected) return;
        emptyFileSelection.current = basis;
        setSelectedOptionId(buildUniversalSearchOptionId(selected.sourceId, selected.scopeKey, selected.id));
    }, [changedFileResults, query, quickOpenSources.defaultSelectedPath, recentFileResults, source, workspaceResolverKey]);
    // Workspace search must use the shared machine-liveness owner. A valid
    // Session/workspace reference with an offline machine is still a real
    // target, but it cannot answer until the machine is reachable; expose that
    // state as a non-activatable section hint instead of issuing a doomed RPC.
    const workspaceMachinePresence = useMachinePresenceSummary(workspaceScope?.serverId, workspaceScope?.machineId);
    const workspaceScopeReachable = workspaceMachinePresence.reachability === 'reachable';
    // Quick open says "isn't answering" only for a machine known to be unreachable; one still loading searches normally.
    const workspaceScopeUnreachable = workspaceMachinePresence.reachability === 'unreachable';
    const workspaceSearchAvailable = workspaceActivationAvailable && selectedCredentialIsCurrent;
    // Names the machine, as the History browser does (lab ST: "MacBook Pro is offline").
    const offlineMachineName = workspaceScope ? machineNameById.get(workspaceScope.machineId) : undefined;
    // The failure lines name the machine the folder lives on, never a raw id.
    const machineLabel = offlineMachineName ?? t('universalSearch.thisMachine');
    const workspaceUnavailableHint = offlineMachineName
        ? t('externalSessions.browseMachineOfflineTitle', { machine: offlineMachineName })
        : t('newSession.machineOfflineInlineTitle');
    const files = React.useMemo<UniversalSearchSource>(() => {
        // An offline folder is said once, under Text in files (lab ST "Machine offline"); this group steps aside.
        if (!workspaceScope || !workspaceSearchAvailable || !selectedCredentialBinding) return source === 'files'
            ? { status: 'unavailable', resolverKey: `${workspaceResolverKey}|missing`, hint: t('universalSearch.content.unavailable') } : { status: 'absent' };
        if (!workspaceScopeReachable && source !== 'files') return { status: 'absent' };
        return {
            status: 'ready',
            resolverKey: `${workspaceResolverKey}|${fileLimit}`,
            loadMore: loadMoreFiles,
            resolve: async (value, signal) => {
                const parsedTarget = parseSearchFileTarget(value);
                if (parsedTarget && ((parsedTarget.serverId && !areServerProfileIdentifiersEquivalent(parsedTarget.serverId, workspaceScope.serverId)) || (parsedTarget.sessionId && parsedTarget.sessionId !== activeSession?.id) || (parsedTarget.workspaceRefId && parsedTarget.workspaceRefId !== workspaceRef?.id))) return { results: [], emptyHint: t('universalSearch.content.unavailable') };
                const path = parsedTarget?.path ?? value;
                const absolute = isAbsoluteLocalPath(path.replace(/\\/g, '/'));
                const parsedPath = absolute ? resolvePathRelativeToRoot({ path, root: workspaceScope.rootPath }) : parsedTarget ? path.replace(/\\/g, '/') : null;
                if ((parsedTarget || absolute) && parsedPath === null) return { results: [], emptyHint: t('universalSearch.content.unavailable') };
                const searchQuery = parsedPath ?? value;
                if (workspaceScopeUnreachable) {
                    const candidates = [...new Map([...quickOpenSources.recent, ...quickOpenSources.changed.map(file => workspacePathToFileSearchItem(file.fullPath))]
                        .map(file => [file.fullPath, file])).values()];
                    // Nothing recent or changed to fall back on: the line says only that the machine isn't answering.
                    if (candidates.length === 0) return { results: [], emptyHint: workspaceUnavailableHint };
                    const literalFile = candidates.find(file => file.fullPath === value);
                    const matches = rankFileSearchResults(createWorkspaceFileSearchIndex(candidates).search(normalizeFileSearchText(searchQuery)), searchQuery);
                    const matchingRecent = new Set(matchWorkspaceFileNames(quickOpenSources.recent, searchQuery).map(file => file.fullPath));
                    const recent = quickOpenSources.recent.filter(file => matchingRecent.has(file.fullPath));
                    const ordered = [...recent, ...matches.filter(file => !matchingRecent.has(file.fullPath))];
                    const items = literalFile ? [literalFile, ...ordered.filter(file => file.fullPath !== literalFile.fullPath)] : ordered;
                    return { results: buildUniversalSearchWorkspaceFileResults({ files: items, changes: changedFileLines,
                        accountId: selectedCredentialBinding.accountId, scope: workspaceScope,
                        workspaceRefId: workspaceRef?.id ?? null, sessionId: activeSession?.id ?? null,
                    }).map(result => !literalFile && parsedTarget?.anchor && result.target.kind === 'workspaceFile'
                        ? { ...result, target: { ...result.target, anchor: parsedTarget.anchor } } : result),
                        resultHint: t('universalSearch.quickOpen.offline', { machine: machineLabel }) };
                }
                const searchFilePage = async (query: string) => {
                    try {
                        return await searchWorkspaceFiles({
                            scope: workspaceScope, query, limit: fileLimit, resultType: 'file',
                            accountLifetime: selectedCredentialBinding, signal, includeCoverage: true,
                        });
                    } catch (error) {
                        if (error instanceof WorkspaceFileSearchUnavailableError && error.errorCode === 'root_not_found') throw workspaceFolderMissingFailure();
                        throw error;
                    }
                };
                const [page, literalPage] = await Promise.all([
                    searchFilePage(parsedPath ?? value),
                    parsedTarget && !parsedTarget.sessionId && !parsedTarget.workspaceRefId && parsedPath !== value ? searchFilePage(value) : Promise.resolve(null),
                ]);
                if (signal.aborted || !selectedCredentialBinding.isCurrent()) return [];
                const literalFile = literalPage?.items.find(file => file.fullPath === value);
                const pageItems = literalFile ? [literalFile, ...page.items.filter(file => file.fullPath !== literalFile.fullPath)]
                    : [...page.items, ...(literalPage?.items ?? []).filter((candidate) => !page.items.some((item) => item.fullPath === candidate.fullPath))];
                const existingPaths = page.corpusTruncated ? null : workspaceFileSearchCache.readFiles(workspaceScope, selectedCredentialBinding)
                    ?.filter(file => file.fileType === 'file').map(file => file.fullPath) ?? null;
                const recentMatches = new Set(matchWorkspaceFileNames(quickOpenSources.recentPaths.map(workspacePathToFileSearchItem), searchQuery).map(file => file.fullPath));
                const recentPaths = literalFile ? [] : selectRecentWorkspaceFiles(quickOpenSources.recentPaths, existingPaths, recentMatches);
                const recentSet = new Set(recentPaths);
                const fileItems = [...recentPaths.map(workspacePathToFileSearchItem), ...pageItems.filter(file => !recentSet.has(file.fullPath))];
                const fileResults = buildUniversalSearchWorkspaceFileResults({
                    files: fileItems,
                    changes: changedFileLines,
                    accountId: selectedCredentialBinding.accountId,
                    scope: workspaceScope,
                    workspaceRefId: workspaceRef?.id ?? null,
                    sessionId: activeSession?.id ?? null,
                });
                return {
                    results: fileResults.map((result) => {
                        if (literalFile || !parsedTarget?.anchor || !parsedPath || result.target.kind !== 'workspaceFile') return result;
                        const actualPath = resolvePathRelativeToRoot({ path: `${workspaceScope.rootPath}/${result.target.path}`, root: workspaceScope.rootPath });
                        const targetPath = resolvePathRelativeToRoot({ path: `${workspaceScope.rootPath}/${parsedPath}`, root: workspaceScope.rootPath });
                        const exactPath = actualPath !== null && targetPath !== null ? actualPath === targetPath : result.target.path === parsedPath;
                        return exactPath || (!parsedTarget.sessionId && !parsedTarget.workspaceRefId)
                            ? { ...result, target: { ...result.target, anchor: parsedTarget.anchor, ...(parsedTarget.anchorSource ? { anchorSource: parsedTarget.anchorSource } : {}) } } : result;
                    }),
                    hasMore: resolveWorkspaceFileSearchPageAvailability(page, fileLimit).canLoadMore,
                    ...boundedReplyHints({ rowCount: fileResults.length, incomplete: page.corpusTruncated || literalPage?.corpusTruncated === true }),
                };
            },
        };
    }, [activeSession?.id, changedFileLines, fileLimit, loadMoreFiles, machineLabel, workspaceScopeUnreachable, workspaceUnavailableHint, quickOpenSources.changed, quickOpenSources.recent, quickOpenSources.recentPaths, selectedCredentialBinding, source, workspaceRef?.id, workspaceResolverKey, workspaceScope, workspaceScopeReachable, workspaceSearchAvailable]);
    const fileContent = React.useMemo<UniversalSearchSource>(() => {
        if (!workspaceScope || !workspaceSearchAvailable || !selectedCredentialBinding) return source === 'fileContent' ? { status: 'unavailable', resolverKey: `${workspaceResolverKey}|missing`, hint: t('universalSearch.content.unavailable') } : { status: 'absent' };
        if (!workspaceScopeReachable) return { status: 'unavailable', resolverKey: `${workspaceResolverKey}|offline`, hint: workspaceUnavailableHint };
        return {
            status: 'ready', resolverKey: `${workspaceResolverKey}|${matchCase}|${regex}`,
            resolve: async (value, signal) => {
                const page = await searchWorkspaceFileContents({ scope: workspaceScope, accountLifetime: selectedCredentialBinding, query: value, matchCase, regex, signal });
                if (signal.aborted || !selectedCredentialBinding.isCurrent()) throw Object.assign(new Error('Search cancelled'), { name: 'AbortError' });
                if (page.error) {
                    const presented = presentContentSearchError(page.error, { machine: machineLabel, group: t('universalSearch.content.textInFiles') });
                    if (presented.kind === 'failure') throw presented.failure;
                    return { results: [], emptyHint: presented.hint, resultHint: presented.hint };
                }
                const scopeKey = buildUniversalSearchScopeKey([selectedCredentialBinding.accountId, workspaceScope.serverId, workspaceScope.machineId, workspaceScope.rootPath]);
                const results: UniversalSearchResult[] = page.items.flatMap((file) => file.matches.map((match) => {
                    const anchor = { kind: 'fileLine' as const, startLine: match.line };
                    return { id: `${file.path}:${match.line}:${match.column16}`, sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.fileContent, scopeKey, kind: 'workspaceFile', title: file.path, subtitle: `${file.path}:${match.line}`, fileContent: { path: file.path, ...match }, target: { kind: 'workspaceFile' as const, scope: workspaceScope, path: file.path, anchor, find: { query: value, options: { matchCase, regex }, target: { kind: 'file' as const, path: file.path, anchor } }, workspaceRefId: workspaceRef?.id ?? null, sessionId: activeSession?.id ?? null, serverId: workspaceScope.serverId, accountId: selectedCredentialBinding.accountId } };
                }));
                return { results, hasMore: page.hasMore,
                    ...(page.coverage === 'partial' ? { resultHint: t('universalSearch.content.partial') } : {}) };
            },
        };
    }, [activeSession?.id, matchCase, regex, selectedCredentialBinding, source, workspaceRef?.id, workspaceResolverKey, workspaceScope, workspaceScopeReachable, workspaceSearchAvailable, workspaceUnavailableHint, machineLabel]);
    const replaceMatcher = React.useMemo<WorkspaceReplaceMatcher | null>(() => source === 'fileContent' && replaceOpen
        && query.length > 0 && !terminalJump ? { query, replacement, matchCase, regex } : null, [matchCase, query, regex, replaceOpen, replacement, source, terminalJump]);
    // Files with an unsaved editor draft are never written by replace; they are listed and skipped.
    const unsavedPaths = React.useMemo(() => unsavedWorkspaceFilePaths({ accountId: scope.accountId, workspaceScope,
        paneScopes: paneContext?.state.scopes, workspaceRefs, sessionState: storage.getState() }),
    [paneContext?.state.scopes, scope.accountId, workspaceScope, workspaceRefs, sessions, sessionListRowsByServerId, machines,
        dirtyTargetMachineLists, dirtyTargetMachineListStatus]);
    const replaceModel = useWorkspaceReplace({
        scope: replaceMatcher && selectedCredentialIsCurrent ? workspaceScope : null,
        available: workspaceScopeReachable,
        accountLifetime: selectedCredentialIsCurrent ? selectedCredentialBinding : null,
        matcher: replaceMatcher, unsavedPaths,
    });
    useReplaceUndoOnClose(replaceModel, replaceModel.undoOnClose
        ? machineNameById.get(replaceModel.undoOnClose.machineId) ?? t('universalSearch.thisMachine')
        : machineLabel);
    const reviewActive = replaceMatcher !== null;
    const commits = React.useMemo<UniversalSearchSource>(() => {
        // An offline folder is said once, under Text in files (lab ST "Machine offline"); this group steps aside.
        if (!workspaceScope || !workspaceSearchAvailable || !selectedCredentialBinding || !workspaceScopeReachable) return { status: 'absent' };
        return {
            status: 'ready',
            resolverKey: workspaceResolverKey,
            resolve: async (value, signal) => {
                const outcome = await searchWorkspaceCommits({
                    scope: workspaceScope,
                    accountId: selectedCredentialBinding.accountId,
                    accountIsCurrent: () => selectedCredentialBinding.isCurrent(),
                    query: value,
                    limit: 20,
                    signal,
                });
                if (outcome.status === 'unavailable') {
                    throw presentCommitSearchFailure(outcome, { machine: machineLabel, folder: workspaceScope.rootPath }) ?? new Error(outcome.message ?? outcome.reason);
                }
                if (outcome.status === 'recentOnly') {
                    return {
                        results: [],
                        emptyHint: t('universalSearch.commitsUpdateRequired'),
                    };
                }
                return outcome.entries.map((entry) => ({
                    id: entry.sha,
                    scopeKey: buildUniversalSearchScopeKey([selectedCredentialBinding.accountId, workspaceScope.serverId, workspaceScope.machineId, workspaceScope.rootPath]),
                    sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.commits,
                    kind: 'workspaceCommit',
                    title: entry.subject,
                    subtitle: `${entry.shortSha} · ${entry.authorName}`,
                    target: { kind: 'workspaceCommit', scope: workspaceScope, sha: entry.sha, workspaceRefId: workspaceRef?.id ?? null, sessionId: activeSession?.id ?? null, serverId: workspaceScope.serverId, accountId: selectedCredentialBinding.accountId },
                }));
            },
        };
    }, [activeSession?.id, selectedCredentialBinding, workspaceRef?.id, workspaceResolverKey, workspaceScope, workspaceScopeReachable, workspaceSearchAvailable, workspaceUnavailableHint, machineLabel]);

    const accountLifetime = pluginAccount.lifetime;
    const currentPluginProjectionRef = React.useRef(pluginProjection.pluginUiProjection);
    currentPluginProjectionRef.current = pluginProjection.pluginUiProjection;
    const pluginScopeIsCurrent = React.useCallback((pluginId: string, occurrenceId: string) => {
        const current = currentPluginProjectionRef.current;
        return accountLifetime !== null
            && accountLifetime.isCurrent()
            && Object.values(current?.searchProvidersById ?? {}).some((provider) => (
                provider.pluginId === pluginId && provider.occurrenceId === occurrenceId
            ));
    }, [accountLifetime]);
    const clientRegistrationRevision = usePluginUiClientExecutableRegistrationRevision();
    const pluginSections = React.useMemo(() => buildPluginSearchProviderSections({
        projection: pluginProjection.pluginUiProjection,
        scopedLaunchFacts: {
            serverId: scope.serverId,
            machineId: scope.machineId,
            interactionEnabled: pluginProjection.interactionEnabled,
        },
        accountLifetime,
        accountLifetimeRevision: pluginAccount.revision,
        isOccurrenceCurrent: pluginScopeIsCurrent,
        readCurrentUiContext: currentUiContextReader?.readCurrentUiContext,
        openSurface: pluginNavigationBinding?.openSurface,
        onCommitActivation: (activate) => { committedPluginActivationRef.current = activate; },
    }), [accountLifetime, clientRegistrationRevision, currentUiContextReader, pluginAccount.revision, pluginNavigationBinding?.openSurface, pluginProjection, pluginScopeIsCurrent, scope.machineId, scope.serverId]);

    const accountIdByServerId = React.useMemo(() => new Map(
        [...credentialBindings].map(([serverId, binding]) => [serverId, binding.accountId]),
    ), [credentialBindings]);
    const scopeChoices = React.useMemo(() => buildUniversalSearchScopeChoices({
        accountIdByServerId,
        profiles,
        workspaces: workspaceRefs,
        sessions,
        readMachineTarget: readMachineControlTargetForSession,
        includeAllMachines: true,
        allMachinesLabel: t('conversationSearch.scopeAllMachines'),
    }), [accountIdByServerId, profiles, sessions, workspaceRefs]);
    const scopeKey = buildUniversalSearchScopeKeyFromSeed(scope);
    // The scope chip exists only when there is a choice to make. With one Home (and no workspace
    // scopes) it would restate the obvious, so Search shows no chip at all.
    const hasScopeChoice = scopeChoices.length > 1;
    const currentScopeProfile = profiles.find((profile) => areServerProfileIdentifiersEquivalent(profile.id, scope.serverId));
    const currentScopeLabel = scopeChoices.find((choice) => choice.key === scopeKey)?.label
        ?? (currentScopeProfile ? resolveHomeDisplayLabel(currentScopeProfile, currentScopeProfile.id) : null)
        ?? scope.rootPath?.split(/[\\/]/).filter(Boolean).pop()
        ?? '';
    // The Home (or workspace) scope is a SelectionList filter: one chip beside the field that opens the
    // choices, the same chip every picker uses.
    const scopeFilters = React.useMemo<ReadonlyArray<SelectionListFilter> | undefined>(() => hasScopeChoice ? [{
        id: 'scope',
        label: t('universalSearch.scopeFilterLabel'),
        valueLabel: currentScopeLabel,
        // The chip shows what the scope is: a Home, or every machine in it.
        icon: <Icon name={scope.machineScope === 'all' ? 'desktop' : 'house'} size={12} color={theme.colors.text.secondary} />,
        options: scopeChoices.map((choice) => choice.scope.machineScope === 'all'
            ? { id: choice.key, label: choice.label, subtitle: t('conversationSearch.scopeAllMachinesSubtitle'),
                icon: <Icon name="desktop" size={14} color={theme.colors.text.secondary} /> }
            // A folder scope says where it lives, as project rows do, so two "happier" folders read apart.
            : choice.scope.rootPath && choice.scope.machineId
                ? { id: choice.key, label: choice.label, subtitle: [formatPathRelativeToHome(choice.scope.rootPath, machineHomeById.get(choice.scope.machineId)),
                    machineNameById.get(choice.scope.machineId)].filter(Boolean).join(' · ') }
                : { id: choice.key, label: choice.label }),
        selectedId: scopeKey,
        onChange: (choiceKey: string) => {
            const choice = scopeChoices.find((candidate) => candidate.key === choiceKey);
            if (!choice) return;
            setSelectedOptionId(null);
            setScope(choice.scope);
        },
        testID: 'universal-search:scope',
    }] : undefined, [currentScopeLabel, hasScopeChoice, machineHomeById, machineNameById, scope.machineScope, scopeChoices, scopeKey, theme.colors.text.secondary]);

    const conversationMachineId = scope.machineId ?? workspaceScope?.machineId ?? null;
    const scanAvailability = useConversationSearch({ query: { v: 1, query: '', scope: { type: 'global' }, mode: 'auto' },
        mode: 'indexed', providers: { homeSessions: false, daemonEnabled: memoryProvider.conversation?.daemonEnabled === true }, accountLifetime: selectedCredentialBinding,
        ...(scope.machineScope !== 'all' ? { machineIds: conversationMachineId ? [conversationMachineId] : [] } : {}),
        enabled: selectedCredentialIsCurrent,
    });
    const beginExternalConversationSearch = React.useCallback((value: string) => {
        const machineId = conversationMachineId ?? scanAvailability.result?.machines.find(machine => machine.standardSearchEnabled)?.machineId;
        if (!machineId || !canonicalScopeServerId || !scope.accountId
            || !selectedCredentialBinding?.isCurrent() || selectedCredentialBinding.accountId !== scope.accountId) return;
        const activeScope = pluginAccount.lifetime?.scope;
        const machineLabel = activeScope?.accountId === scope.accountId
            && areServerProfileIdentifiersEquivalent(activeScope.serverId, canonicalScopeServerId)
            ? machineNameById.get(machineId) ?? machineId
            : machineId;
        setExternalConversationSearch({
            target: { machineId, serverId: canonicalScopeServerId, accountId: scope.accountId },
            ...(scope.machineScope === 'all' ? { machineIds: scanAvailability.result?.machines.map(machine => machine.machineId) ?? [] } : {}),
            query: value, machineLabel, accountLifetime: selectedCredentialBinding,
        });
    }, [canonicalScopeServerId, conversationMachineId, machineNameById, pluginAccount.lifetime, scanAvailability.result, scope.accountId, scope.machineScope, selectedCredentialBinding]);
    const selectSource = React.useCallback((next: string) => {
        activationGeneration.current += 1;
        setSelectedOptionId(null);
        setSource(next === 'fileContent' || next === 'files' || next === 'symbols' ? next : undefined);
        if (next !== 'fileContent') { setMatchCase(false); setRegex(false); setReplaceOpen(false); }
    }, []);
    const showAllFileMatches = React.useCallback(() => selectSource('fileContent'), [selectSource]);
    const searchEverything = React.useCallback(() => selectSource('everything'), [selectSource]);
    const fileContentFolderLabel = workspaceScope
        ? workspaceRef?.label?.trim() || workspaceScope.rootPath.split(/[\\/]/).filter(Boolean).pop() : undefined;
    const fileContentScopeLabel = workspaceScope ? [
        fileContentFolderLabel,
        machineNameById.get(workspaceScope.machineId) ?? workspaceScope.machineId,
    ].filter(Boolean).join(' · ') : undefined;
    // No folder in scope: Text in files offers the recent project folders instead of guessing one.
    const fileContentFolders = React.useMemo<ReadonlyArray<UniversalSearchFolderSuggestion>>(() => workspaceScope
        ? []
        : projects.map((project) => ({
            id: project.workspaceRefId,
            name: project.title,
            ...(project.subtitle ? { subtitle: project.subtitle } : {}),
            onSelect: () => {
                setSelectedOptionId(null);
                setScope(scopeChoices.find((choice) => choice.scope.machineId === project.machineId
                    && choice.scope.rootPath === project.rootPath)?.scope
                    ?? { accountId: project.accountId, serverId: project.serverId, machineId: project.machineId, rootPath: project.rootPath, sessionId: null });
            },
        })), [projects, scopeChoices, workspaceScope]);
    // Opening a reviewed row (its file at the line) goes through the same activation as a Text in files hit.
    const commitReplaceOpen = React.useCallback((path: string, line: number) => {
        if (!workspaceScope || !selectedCredentialBinding) return;
        const anchor = { kind: 'fileLine' as const, startLine: line };
        committedResultRef.current = { id: `${path}:${line}`, sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.fileContent,
            scopeKey: buildUniversalSearchScopeKey([selectedCredentialBinding.accountId, workspaceScope.serverId, workspaceScope.machineId, workspaceScope.rootPath]),
            kind: 'workspaceFile', title: path, subtitle: `${path}:${line}`,
            target: { kind: 'workspaceFile', scope: workspaceScope, path, anchor,
                find: { query, options: { matchCase, regex }, target: { kind: 'file', path, anchor } },
                workspaceRefId: workspaceRef?.id ?? null, sessionId: activeSession?.id ?? null,
                serverId: workspaceScope.serverId, accountId: selectedCredentialBinding.accountId } };
    }, [activeSession?.id, matchCase, query, regex, selectedCredentialBinding, workspaceRef?.id, workspaceScope]);
    const replaceSections = React.useMemo(() => replaceMatcher ? buildReplaceReviewSections({
        model: replaceModel, matcher: replaceMatcher, scopeLabel: fileContentFolderLabel ?? t('universalSearch.content.textInFiles'),
        machineLabel, available: Boolean(workspaceScope && workspaceSearchAvailable && selectedCredentialBinding),
        reachable: workspaceScopeReachable, commitOpen: commitReplaceOpen, compact: deviceType === 'phone',
        ...(props.presentation === 'modal' ? { onLeaveForApproval: requestClose } : {}),
    }) : null, [props.presentation, requestClose, commitReplaceOpen, deviceType, fileContentFolderLabel, machineLabel, replaceMatcher, replaceModel, selectedCredentialBinding, workspaceScope, workspaceScopeReachable, workspaceSearchAvailable]);
    const searchSections = React.useMemo(() => buildUniversalSearchSections({
        query,
        commands: props.commands,
        sessions: sessionEntities,
        sessionInventoryStatus,
        projects,
        searchSettingsPages,
        transcript,
        files,
        recentFiles: recentFileResults,
        changedFiles: changedFileResults,
        changedFilesScope: activeSession ? 'session' : 'folder',
        ...(workspaceScope && workspaceScopeUnreachable ? { filesStatusHint: t('universalSearch.quickOpen.offline', { machine: machineLabel }) } : {}),
        ...(source === 'files' && fileContentFolderLabel ? { filesNoMatch: { scopeLabel: fileContentFolderLabel, onSearchEverything: searchEverything } } : {}),
        symbols: symbolsSource,
        fileContent,
        fileContentScopeLabel,
        fileContentFolders,
        onShowAllFileMatches: showAllFileMatches,
        source,
        commits,
        pluginSections,
        ...((conversationMachineId || scope.machineScope === 'all') && canonicalScopeServerId && selectedCredentialIsCurrent ? {
            externalConversationSearch: {
                standardSearchEnabled: hasConversationSearchScanFallback(scanAvailability.result),
                // Every machine in scope is scanned when the scope says so; the row then names no single machine.
                ...(scope.machineScope !== 'all' && conversationMachineId ? {
                    machineLabel: pluginAccount.lifetime?.scope.accountId === scope.accountId
                        && areServerProfileIdentifiersEquivalent(pluginAccount.lifetime.scope.serverId, canonicalScopeServerId)
                        ? machineNameById.get(conversationMachineId) ?? conversationMachineId : conversationMachineId,
                } : {}),
                onSearch: beginExternalConversationSearch,
            },
        } : {}),
        onCommitResult: (result) => { committedResultRef.current = result; },
    }), [activeFilePath, activeSession, searchEverything, fileContentFolderLabel, beginExternalConversationSearch, canonicalScopeServerId, changedFileResults, commits, conversationMachineId, fileContent, fileContentFolders, fileContentScopeLabel, files, machineNameById, pluginAccount.lifetime, pluginSections, projects, props.commands, query, recentFileResults, scanAvailability.result, scope.accountId, scope.machineScope, searchSettingsPages, selectedCredentialIsCurrent, sessionEntities, sessionInventoryStatus, showAllFileMatches, source, symbolsSource, transcript, workspaceResolverKey]);
    const sections = replaceSections ?? searchSections;
    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: 'universal-search',
        // Quick open names its one job (lab FB2 "Go to file").
        inputPlaceholder: source === 'files' ? t('projects.code.goToFile') : t('commandPalette.placeholder'),
        emptyStateLabel: t('selectionList.emptyMatch'),
        sections,
        // The review is the Machine's answer for the typed query; the field never narrows it further.
        ...(replaceSections ? { disableInputFilter: true } : {}),
        // Quiet key hints; SelectionList shows the footer only with a hardware keyboard.
        // In Text in files every row is a line: Return opens it there, and ⌫ on the empty field goes back
        // to everything (lab G1s). With text hits inline, the hint names the shortcut to the scope (lab G1).
        footerHints: replaceSections ? [
            { id: 'move', label: '↑↓', description: t('commandPalette.hints.move') },
            ...(replaceModel.results ? [{ id: 'open', label: '↵', description: t('commandPalette.hints.open') }] : [
                { id: 'include', label: '↵', description: t('universalSearch.replace.includeHint') },
                { id: 'open', label: '⌘↵', description: t('commandPalette.hints.openAtLine') },
            ]),
        ] : source === 'files' ? [
            // Lab FB2: ⌘↵ opens the file beside, ⌫ on the empty field leaves the scope.
            { id: 'move', label: '↑↓', description: t('commandPalette.hints.move') },
            { id: 'open', label: '↵', description: t('commandPalette.hints.open') },
            { id: 'beside', label: '⌘↵', description: t('files.pane.menu.openBeside') },
            { id: 'everything', label: '⌫', description: t('universalSearch.quickOpen.searchEverything') },
            { id: 'close', label: 'esc', description: t('commandPalette.hints.close') },
        ] : source === 'fileContent' ? [
            { id: 'move', label: '↑↓', description: t('commandPalette.hints.move') },
            { id: 'open', label: '↵', description: t('commandPalette.hints.openAtLine') },
            { id: 'everything', label: '⌫', description: t('universalSearch.content.everything') },
            { id: 'close', label: 'esc', description: t('commandPalette.hints.close') },
        ] : [
            { id: 'move', label: '↑↓', description: t('commandPalette.hints.move') },
            { id: 'open', label: '↵', description: t('commandPalette.hints.open') },
            ...(workspaceScope && query.trim().length > 0 && textInFilesShortcut
                ? [{ id: 'text-in-files', label: textInFilesShortcut, description: t('universalSearch.content.textInFiles') }] : []),
            { id: 'close', label: 'esc', description: t('commandPalette.hints.close') },
        ],
    }), [query, replaceModel.results, replaceSections, sections, source, textInFilesShortcut, workspaceScope]);

    const leaveTerminalScope = React.useCallback(() => {
        setSelectedOptionId(null);
        setTerminalScope(null);
    }, []);
    const terminalScopeChrome = useTerminalJumpScopeChrome(terminalJump !== null, leaveTerminalScope);
    const activateTerminalJump = React.useCallback((optionId: string, placement: 'bottom' | 'details') => {
        if (!terminalJump) return;
        setSelectedOptionId(optionId);
        void runUniversalSearchActivation({
            prepare: () => terminalJump.hasOption(optionId),
            dismiss: props.onRequestClose,
            activate: () => terminalJump.activate(optionId, placement),
            presentFailure: () => { Modal.alert(t('common.error'), t('errors.searchFailed')); },
        });
    }, [props.onRequestClose, terminalJump]);
    const handleTerminalJumpSelect = React.useCallback((optionId: string) => activateTerminalJump(optionId, 'bottom'), [activateTerminalJump]);
    const handleTerminalJumpDetails = React.useCallback((optionId: string) => activateTerminalJump(optionId, 'details'), [activateTerminalJump]);

    const isBuiltInTargetCurrent = React.useCallback((target: UniversalSearchResult['target']) => {
        if (target.kind === 'workspaceSymbol') {
            const input = readSymbolsInput();
            if (!input || target.path !== input.target.path || target.workspaceRefId !== input.target.workspaceRefId
                || target.sessionId !== input.target.sessionId
                || tryBuildWorkspaceCacheKey(target.scope) !== tryBuildWorkspaceCacheKey(input.target.scope)) return false;
        }
        const targetServerId = 'serverId' in target ? target.serverId : null;
        const targetAccountId = 'accountId' in target ? target.accountId : null;
        const activationBindings = paneContext?.fileFindSeedAccountBindings ?? credentialBindings;
        const targetBinding = targetServerId
            ? activationBindings.get(resolveServerProfileScopeIdForIdentifier(targetServerId)) ?? null
            : null;
        return isUniversalSearchTargetCurrent({
            target,
            accountScope: targetServerId && profiles.some((profile) => areServerProfileIdentifiersEquivalent(profile.id, targetServerId))
                ? {
                    serverId: resolveServerProfileScopeIdForIdentifier(targetServerId),
                    accountId: targetAccountId ?? '',
                    current: targetAccountId !== null
                        && targetBinding !== null
                        && areServerProfileIdentifiersEquivalent(targetBinding.serverId, targetServerId)
                        && targetBinding.accountId === targetAccountId
                        && targetBinding.isCurrent(),
                }
                : null,
            workspaces: workspaceRefs,
            settingsPages: settingsById,
            resolveSessionWorkspaceTarget: resolveWorkspaceTargetForSession,
            isWorkspaceScopeReachable,
        });
    }, [credentialBindings, paneContext, profiles, readSymbolsInput, settingsById, workspaceRefs]);

    const readExactSessionForActivation = React.useCallback(async (target: Readonly<{
        serverId: string;
        accountId: string;
        sessionId: string;
    }>): Promise<Readonly<{ ok: boolean; visibleThroughSeq?: number }>> => {
        const binding = credentialBindings.get(
            resolveServerProfileScopeIdForIdentifier(target.serverId),
        ) ?? null;
        if (
            !binding
            || !binding.isCurrent()
            || binding.accountId !== target.accountId
            || !areServerProfileIdentifiersEquivalent(binding.serverId, target.serverId)
        ) return { ok: false };

        const controller = new AbortController();
        const retirement = binding.onRetire(() => controller.abort());
        let authority: Awaited<ReturnType<typeof captureMemorySearchSessionReadAuthority>> | null = null;
        try {
            authority = await captureMemorySearchSessionReadAuthority({
                serverId: target.serverId,
                accountId: target.accountId,
            });
            if (controller.signal.aborted || !binding.isCurrent()) return { ok: false };
            const read = await readMemorySearchSessionForServerScope({
                target: {
                    sessionKey: buildUniversalSearchScopeKey([
                        target.accountId,
                        target.serverId,
                        target.sessionId,
                    ]),
                    ...target,
                },
                authority,
                signal: controller.signal,
            });
            return read.ok && !controller.signal.aborted && binding.isCurrent()
                ? read
                : { ok: false };
        } catch {
            return { ok: false };
        } finally {
            retirement.dispose();
            await authority?.release();
        }
    }, [credentialBindings]);

    const handleSelect = React.useCallback((optionId: string, _option: SelectionListOption, intent: 'preview' | 'beside' = 'preview') => {
        if (optionId === EXTERNAL_CONVERSATION_SEARCH_OPTION_ID || optionId === ALL_FILE_MATCHES_OPTION_ID || optionId === MORE_FILES_OPTION_ID
            || optionId.startsWith(FILE_CONTENT_FOLDER_OPTION_PREFIX)) {
            committedResultRef.current = null;
            committedPluginActivationRef.current = null;
            setSelectedOptionId(null);
            return;
        }
        // A review row includes or leaves out its matches in place; only a committed open leaves the surface.
        if (optionId.startsWith(REPLACE_OPTION_PREFIX) && !committedResultRef.current) return;
        const result = committedResultRef.current;
        const pluginActivation = committedPluginActivationRef.current;
        const command = result || pluginActivation ? null : findCommandForOptionId(props.commands, optionId);
        committedResultRef.current = null;
        committedPluginActivationRef.current = null;
        setSelectedOptionId(optionId);
        const sourceAccountIsCurrent = () => {
            if (!result || !('accountId' in result.target)) return true;
            const target = result.target;
            const serverId = 'scope' in target ? target.scope.serverId : target.serverId;
            const binding = credentialBindings.get(resolveServerProfileScopeIdForIdentifier(serverId));
            return binding?.isCurrent() === true && binding.accountId === target.accountId;
        };
        const generation = activationGeneration.current;
        void runUniversalSearchActivation({
            isCurrent: () => activationGeneration.current === generation,
            prepare: () => result
                ? sourceAccountIsCurrent() && prepareUniversalSearchResult(result.target, {
                    isTargetCurrent: isBuiltInTargetCurrent,
                    readExactSession: readExactSessionForActivation,
                })
                : pluginActivation
                    ? accountLifetime?.isCurrent() === true
                    : command !== null,
            dismiss: props.onRequestClose,
            activate: async () => {
                if (result) {
                    const outcome = await activateUniversalSearchResult(result.target, {
                        openExternalConversation: async target => {
                            const binding = credentialBindings.get(resolveServerProfileScopeIdForIdentifier(target.serverId));
                            if (!binding?.isCurrent() || binding.accountId !== target.accountId) return false;
                            return await openConversationSearchResult({ target, accountLifetime: binding,
                                state: { requestToken: 0, linkingCandidateKey: null },
                                openSession: (sessionId, destination, seed) => openChatWithFindSeed({
                                    handoff: paneContext?.fileFindSeedHandoff, destination: { sessionId, serverId: destination.serverId ?? '' },
                                    seed, authority: paneContext?.fileFindSeedAccountBindings.get(resolveServerProfileScopeIdForIdentifier(destination.serverId)),
                                    open: () => navigateToSession(sessionId, { serverId: destination.serverId ?? undefined }),
                                }),
                            });
                        },
                        navigateToSession: (sessionId, options) => {
                            const { find, ...destination } = options ?? {};
                            return openChatWithFindSeed({
                                handoff: paneContext?.fileFindSeedHandoff,
                                destination: { sessionId, serverId: destination.serverId ?? '' }, seed: find,
                                // The destination owns launch custody after Search dismisses.
                                authority: paneContext?.fileFindSeedAccountBindings.get(resolveServerProfileScopeIdForIdentifier(destination.serverId)),
                                open: () => navigateToSession(sessionId, destination),
                            });
                        },
                        push: (path) => { router.push(path as never); },
                        openProject,
                        openFile,
                        isTargetCurrent: isBuiltInTargetCurrent,
                    }, { intent });
                    return outcome.ok ? true : outcome.reason === 'cancelled' ? null : false;
                }
                if (pluginActivation) {
                    const outcome = await pluginActivation() as PluginSearchActivationOutcome;
                    return outcome.ok;
                }
                if (command) {
                    await command.action();
                    return true;
                }
                return false;
            },
            presentFailure: () => { Modal.alert(t('common.error'), t('errors.searchFailed')); },
        });
    }, [credentialBindings, isBuiltInTargetCurrent, navigateToSession, openFile, openProject, paneContext, pluginScopeIsCurrent, props.commands, props.onRequestClose, readExactSessionForActivation, router]);

    const handleCommandSelect = React.useCallback((optionId: string, option: SelectionListOption) => {
        // ⌘↵ on a reviewed match opens its file at the line, beside, like a Text in files hit.
        const match = /^replace:match:(.*):(\d+):\d+$/u.exec(optionId);
        if (match) commitReplaceOpen(match[1]!, Number(match[2]));
        else if (optionId.startsWith(REPLACE_OPTION_PREFIX)) return;
        handleSelect(optionId, option, 'beside');
    }, [commitReplaceOpen, handleSelect]);
    useKeyboardShortcutHandlers(React.useMemo(() => ({
        'search.replace.apply': () => {
            if (!reviewActive || !replaceModel.canApply) return 'pass';
            void replaceModel.apply();
            return 'handled';
        },
    }), [replaceModel, reviewActive]));

    const activeRootStep = terminalJump?.step ?? rootStep;
    // Find lab G1s: Text in files is a scope token that × (or ⌫ on an empty field) removes; Search over
    // everything shows no source chip. The way in is the "All matches" row, ⌘⇧F, or its command.
    const sourceFilters = React.useMemo<readonly SelectionListFilter[]>(() => source ? [{
        id: 'source',
        label: t('tools.names.search'),
        // Names the folder and machine it searches (lab G1s "Text in happier · MacBook Pro"), not only what it searches.
        valueLabel: source === 'files' ? t('universalSearch.quickOpen.filesInScope', { scope: fileContentFolderLabel ?? t('universalSearch.sections.files') })
            : source === 'symbols' ? activeFilePath ? t('universalSearch.quickOpen.symbolsInFile', { file: activeFilePath.split('/').at(-1) ?? activeFilePath }) : t('universalSearch.quickOpen.symbolsNeedFile')
            : fileContentScopeLabel ? t('universalSearch.content.textInScope', { scope: fileContentScopeLabel }) : t('universalSearch.content.textInFiles'),
        // The chip row beneath the field on a phone names the folder alone (lab G1sp "Text in happier"); the machine stays in the name.
        ...(source === 'fileContent' && fileContentFolderLabel ? { rowValueLabel: t('universalSearch.content.textInScope', { scope: fileContentFolderLabel }) } : {}),
        // The token carries what it searches: a file for quick open (lab FB2), code for symbols, Aa for text.
        icon: <Icon name={source === 'files' ? 'file' : source === 'symbols' ? 'code' : 'text-aa'} size={12} color={theme.colors.text.secondary} />,
        active: true,
        onClear: () => selectSource(source === 'symbols' ? 'files' : 'everything'),
        clearAccessibilityLabel: t('universalSearch.content.everything'),
        testID: 'universal-search:source',
    }] : [], [activeFilePath, fileContentFolderLabel, fileContentScopeLabel, selectSource, source, theme.colors.text.secondary]);
    const combinedFilters = React.useMemo(() => [...(scopeFilters ?? []), ...sourceFilters], [scopeFilters, sourceFilters]);
    // ⌫ on an empty field drops the Text in files token, as it leaves the Terminals scope (lab G1s).
    const sourceInputBehavior = React.useMemo<SelectionListInputBehavior | undefined>(() => source ? {
        onBackspaceAtEnd: (input) => {
            if (input.length > 0) return null;
            selectSource(source === 'symbols' ? 'files' : 'everything');
            return '';
        },
    } : undefined, [selectSource, source]);
    const activeFilters = terminalJump ? terminalScopeChrome.filters : combinedFilters;
    // Aa and .* read as the Find bar's toggles (lab G1s): quiet mono glyphs, no well at rest, the accent ink when on.
    const optionGlyph = (glyph: string, on: boolean) => <Text style={[Typography.mono(), Typography.variant('meta'), { fontWeight: '600', color: on ? theme.colors.state.active.foreground : theme.colors.text.secondary }]}>{glyph}</Text>;
    const inputSuffix = source === 'fileContent' && !terminalJump ? <View style={{ flexDirection: 'row', gap: theme.space.s4 }}>
        <IconButton testID="universal-search:match-case" variant="plain" icon={optionGlyph('Aa', matchCase)} minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)} interactiveTargetGapPx={4} accessibilityRole="switch" accessibilityLabel={t('universalSearch.content.matchCase')} tooltip={t('universalSearch.content.matchCase')} checked={matchCase} onPress={() => setMatchCase((value) => !value)} />
        <IconButton testID="universal-search:regex" variant="plain" icon={optionGlyph('.*', regex)} minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)} interactiveTargetGapPx={4} accessibilityRole="switch" accessibilityLabel={t('universalSearch.content.regex')} tooltip={t('universalSearch.content.regex')} checked={regex} onPress={() => setRegex((value) => !value)} />
        {replaceOpen ? null : <IconButton testID="universal-search:replace-toggle" variant="plain" icon={<Icon name="arrows-left-right" size={14} color={theme.colors.text.secondary} />} minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)} interactiveTargetGapPx={4} accessibilityLabel={t('universalSearch.replace.show')} tooltip={t('universalSearch.replace.show')} onPress={() => { replaceToggledOpen.current = true; setReplaceOpen(true); }} />}
    </View> : null;
    const replaceField = source === 'fileContent' && replaceOpen && !terminalJump
        // Return in the field never applies (a danger write); ⌥⌘↵ or the button does, after the review.
        ? <ReplaceField value={replacement} onChangeText={setReplacement} onHide={() => setReplaceOpen(false)} autoFocus={replaceToggledOpen.current} />
        : null;
    // Until a preview is on screen the list itself says why (first preview, error): no action to offer yet.
    const replaceFooter = reviewActive && (replaceModel.preview || replaceModel.applying || replaceModel.results)
        ? <ReplaceFooterAction model={replaceModel} compact={deviceType === 'phone'} onDone={requestClose} />
        : null;
    const replaceSummary = reviewActive ? <ReplaceResultSummary model={replaceModel} machineLabel={machineLabel}
        onLeaveForApproval={props.presentation === 'modal' ? requestClose : undefined} /> : null;
    // Full-screen on a phone-width browser (the command surface's phone presentation): the band ends with
    // its way out, as the native Search plane's close does (lab G1sp "Cancel").
    const phoneCancel = Platform.OS === 'web' && props.presentation === 'modal' && deviceType === 'phone'
        // Its own box: a text link aligns to the top of a row, and the band centres its controls.
        ? <View><TextLinkButton testID="universal-search:cancel" tone="strong" label={t('common.cancel')} onPress={requestClose} /></View>
        : null;
    const bandSuffix = inputSuffix || phoneCancel ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>{inputSuffix}{phoneCancel}</View> : null;
    // Text in files and the conversation results show a detail column; everything else is the compact palette.
    // Quick open previews the selected file beside the list as well (lab FB2), and `@` the symbol in it (LS3).
    const surfaceLayout: CommandSurfaceLayout = !terminalJump && (source === 'fileContent' || source === 'files' || source === 'symbols' || externalConversationSearch !== null) ? 'detail' : 'compact';
    const onSurfaceLayoutChange = props.onSurfaceLayoutChange;
    React.useEffect(() => { onSurfaceLayoutChange?.(surfaceLayout); }, [onSurfaceLayoutChange, surfaceLayout]);
    const activeSelect = terminalJump ? handleTerminalJumpSelect : handleSelect;
    const listAccessibilityLabel = terminalJump ? t('terminalWorkspace.jump.title') : t('tools.names.search');
    if (externalConversationSearch?.accountLifetime.isCurrent()) {
        return <ExternalConversationSearchResults {...externalConversationSearch}
            onBack={() => setExternalConversationSearch(null)}
            onRequestClose={props.onRequestClose}
            onOpenSession={async (sessionId, target, find) => {
                const authority = paneContext?.fileFindSeedAccountBindings.get(resolveServerProfileScopeIdForIdentifier(target.serverId));
                await openChatWithFindSeed({
                    handoff: paneContext?.fileFindSeedHandoff,
                    destination: { sessionId, serverId: target.serverId ?? '' }, seed: find, authority,
                    open: () => navigateToSession(sessionId, {
                        ...(target.serverId ? { serverId: target.serverId } : {}),
                    }),
                });
            }}
        />;
    }
    if (Platform.OS !== 'web' && props.presentation === 'route') {
        return <UniversalSearchNativeHost rootStep={activeRootStep} query={query} onChangeQuery={changeQuery} onSelect={activeSelect} onCommandSelect={terminalJump ? handleTerminalJumpDetails : handleCommandSelect} onRequestClose={requestClose} selectedOptionId={selectedOptionId} listAccessibilityLabel={listAccessibilityLabel} filters={activeFilters} inputSuffix={inputSuffix} inputAccessoryRow={replaceField} bodyHeader={replaceSummary} footerAction={replaceFooter} inputBehavior={terminalJump ? terminalScopeChrome.inputBehavior : sourceInputBehavior} dynamicSectionCache={dynamicSectionCache} />;
    }
    return (
        <View style={styles.root} testID="universal-search-host">
            <SelectionList rootStep={activeRootStep} selectionMark="enter" optionPresentation="menu" inputValue={query} onChangeInputValue={changeQuery} onSelect={activeSelect} onCommandSelect={terminalJump ? handleTerminalJumpDetails : handleCommandSelect} onRequestClose={requestClose} selectedOptionId={selectedOptionId} listAccessibilityLabel={listAccessibilityLabel} filters={activeFilters} inputSuffix={bandSuffix} inputAccessoryRow={replaceField} bodyHeader={replaceSummary} footerAction={replaceFooter} inputBehavior={terminalJump ? terminalScopeChrome.inputBehavior : sourceInputBehavior} autoFocusInputOnWeb fillAvailableSpace dynamicSectionCache={dynamicSectionCache}
                // Lab G1s: the code preview column belongs to the Text in files scope; inline hits open their context in the row (G1).
                {...((source === 'fileContent' || source === 'files' || source === 'symbols') && !terminalJump ? { detailPane: COMMAND_SURFACE_DETAIL_PANE } : {})} />
        </View>
    );
}

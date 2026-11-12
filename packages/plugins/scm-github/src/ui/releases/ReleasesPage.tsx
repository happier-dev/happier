import * as React from 'react';
import type { PluginUiContextEnrichmentV1, RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Badge,
  Banner,
  Button,
  DetailsPane,
  DetailsPaneOpenAsPageButton,
  EmptyState,
  ErrorState,
  FreshnessLine,
  Icon,
  IconButton,
  Item,
  ItemGroup,
  LoadingState,
  Menu,
  Row,
  ScrollArea,
  Stack,
  Text,
  usePluginTheme,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import { usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui/hostApi';
import type {
  ForgeReleaseActionInputByOperationV1,
  ForgeReleaseMountedCommandV1,
  ForgeReleaseMountedIntentOperationV1,
  ForgeReleaseMountedIntentResultV1,
  ForgeReleasePageV1,
  ForgeReleaseV1,
} from '@happier-dev/triage-protocol/releases/v1';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { useGithubReleaseQueryV1, useGithubReleaseBindingV1, useReleaseAssetDownloadsV1, useReleaseEditorLifetimeV1 } from './hooks.js';
import { useReleaseDetailV1 } from './detail.js';
import { hasUnsavedReleaseWorkV1, type ReleaseEditorSnapshotV1 } from './editor.js';
import { reduceReleaseListV1, type ReleaseListStateV1 } from './listState.js';
import { createReleasePageActionHandlerV1 } from './model.js';
import { bindReleaseMountedActionsV1 } from './mountedActions.js';
import { GITHUB_RELEASE_MOUNTED_ACTION_ID_V1 } from '../../releases/contracts.js';
import { projectGithubReleaseIdentityV1 } from '../../releases/mapping.js';
import {
  createReleaseLocationBindingV1,
  parseReleaseLocationV1,
  releaseDetailLocationsV1,
  type ReleaseRouteV1,
} from './navigation.js';
import { ReleaseComposer } from './ReleaseComposer.js';
import {
  formatReleaseDayV1,
  ReleaseAssets,
  formatReleaseTargetV1,
  ReleaseByline,
  ReleaseHeadline,
  ReleaseEdgeAligned,
  ReleaseMarks,
  ReleaseNotes,
  ReleaseSessionHelpButton,
  formatGithubPermissionsV1,
  type ReleaseSessionHelpV1,
} from './ReleaseStory.js';
import { triagePagedPanelInitialState } from '@happier-dev/triage-protocol/v1';

/**
 * Project → Releases (lab b1). What shipped from this repository and the next release, read far more
 * than written. The page leads with the next release (or the saved draft), then the newest release as
 * a short story, then earlier releases that open in the Project details pane (pushed on a phone) and expand
 * into the page through the shared Open as page control. Composition only: reads, the editor,
 * navigation and downloads belong to the release owners in this folder.
 */

type Target = Extract<RenderContext['surface']['target'], { kind: 'project' }>;
type Repository = NonNullable<Target['repository']>;
type ListInput = ForgeReleaseActionInputByOperationV1['listReleases'];

const PHONE_MAX_WIDTH = 600;
const COLUMN_MAX_WIDTH = 944;
/** Below this page width the Earlier rows drop their asset and download counts. */
const COMPACT_ROW_MAX_WIDTH = 760;
const GITHUB_ACCOUNT_SERVICE = Object.freeze({
  pluginId: GITHUB_PLUGIN_ID,
  localId: 'github-account',
});

/** Next tag suggestion: the newest tag with its last number incremented. A suggestion, never “latest”. */
export function suggestNextReleaseTagV1(tag: string | null): string {
  if (!tag) return '';
  const match = /^(.*?)(\d+)(\D*)$/u.exec(tag);
  return match ? `${match[1]}${Number(match[2]) + 1}${match[3]}` : '';
}

function failureCopy(
  t: ReturnType<typeof usePluginTranslation>,
  failure: TriageSourceFailureV1,
  repository: string,
) {
  switch (failure.class) {
    case 'permission': {
      const permissions = formatGithubPermissionsV1(failure.detail, t);
      return {
        kind: 'denied' as const,
        title: t(
          'plugins.github.releases.state.noAccess.title',
          'GitHub needs more access to show releases',
        ),
        description: permissions === null
          ? t(
              'plugins.github.releases.state.noAccess.body',
              'This GitHub sign-in can’t read releases in {repository}. Review the credential’s access, or use the GitHub CLI sign-in on this Machine.',
              { repository },
            )
          : t(
              'plugins.github.releases.state.noAccess.bodyRequires',
              'GitHub requires {permissions} to show releases in {repository}. Review the credential’s access, or use the GitHub CLI sign-in on this Machine.',
              { permissions, repository },
            ),
      };
    }
    case 'authentication':
      return {
        kind: 'denied' as const,
        title: t(
          'plugins.github.releases.state.signIn.title',
          'Sign in to GitHub again',
        ),
        description: t(
          'plugins.github.releases.state.signIn.body',
          'The GitHub sign-in for this project expired or was revoked. Signing in again changes nothing else.',
        ),
      };
    case 'rateLimit':
      return {
        kind: 'unavailable' as const,
        title: t(
          'plugins.github.releases.state.rate.title',
          'GitHub is limiting requests',
        ),
        description:
          failure.retryNotBeforeMs === undefined
            ? t(
                'plugins.github.releases.state.rate.bodyNoTime',
                'GitHub is briefly limiting requests. Releases load again once it lets them through.',
              )
            : t(
                'plugins.github.releases.state.rate.body',
                'GitHub resets the limit at {time}.',
                {
                  time: new Intl.DateTimeFormat(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                  }).format(failure.retryNotBeforeMs),
                },
              ),
      };
    default:
      return {
        kind: 'error' as const,
        title: t(
          'plugins.github.releases.state.error.title',
          'Couldn’t read releases',
        ),
        description: t(
          'plugins.github.releases.state.error.body',
          'The releases for {repository} didn’t load, and nothing on GitHub was changed. Details has the reason.',
          { repository },
        ),
      };
  }
}

function freshnessReason(
  t: ReturnType<typeof usePluginTranslation>,
  failure: TriageSourceFailureV1,
): string {
  switch (failure.class) {
    case 'authentication':
      return t(
        'plugins.github.releases.fresh.signIn',
        'The GitHub sign-in expired. Drafting still works on this device.',
      );
    case 'rateLimit':
      return failure.retryNotBeforeMs === undefined
        ? t(
            'plugins.github.releases.fresh.rateNoTime',
            'GitHub is briefly limiting requests; it waits, then reads again.',
          )
        : t(
            'plugins.github.releases.fresh.rate',
            'GitHub resets the limit at {time}. Drafting still works.',
            {
              time: new Intl.DateTimeFormat(undefined, {
                hour: 'numeric',
                minute: '2-digit',
              }).format(failure.retryNotBeforeMs),
            },
          );
    case 'permission': {
      const permissions = formatGithubPermissionsV1(failure.detail, t);
      return permissions === null
        ? t(
            'plugins.github.releases.fresh.permission',
            'GitHub refused the latest read with this sign-in.',
          )
        : t(
            'plugins.github.releases.fresh.permissionRequires',
            'GitHub refused the latest read. It requires {permissions}.',
            { permissions },
          );
    }
    default:
      return t(
        'plugins.github.releases.fresh.error',
        'The latest read didn’t complete.',
      );
  }
}

export type { ReleaseSessionHelpV1 };

/** `sessionHelp` is the configured-handoff consumer; without one the "in a session" entries are not shown. */
export function GithubReleasesPage(
  props: Readonly<{ context: RenderContext; sessionHelp?: ReleaseSessionHelpV1 }>,
): React.ReactElement {
  const t = usePluginTranslation();
  const { context } = props;
  const target =
    context.surface.target.kind === 'project' ? context.surface.target : null;
  const repository =
    target?.repository && target.repository.kind === 'github'
      ? target.repository
      : null;
  if (!target || !repository) {
    return (
      <ScrollArea>
        <Stack style={{ paddingVertical: 48 }}>
          <ErrorState
            kind="unavailable"
            title={t(
              'plugins.github.releases.state.noRepository.title',
              'This project has no GitHub repository yet',
            )}
            description={t(
              'plugins.github.releases.state.noRepository.body',
              'Releases appear once this project’s checkout reports a GitHub remote.',
            )}
          />
        </Stack>
      </ScrollArea>
    );
  }
  return (
    <ReleasesBody context={context} target={target} repository={repository} sessionHelp={props.sessionHelp} />
  );
}

function ReleasesBody(
  props: Readonly<{
    context: RenderContext;
    target: Target;
    repository: Repository;
    sessionHelp: ReleaseSessionHelpV1 | undefined;
  }>,
): React.ReactElement {
  const t = usePluginTranslation();
  const theme = usePluginTheme();
  const { context, target, repository, sessionHelp } = props;
  const host = context.hostApi;
  const locale = context.surface.locale;
  const { authorityKey, reads } = useGithubReleaseBindingV1(context);
  const listInput = React.useMemo<ListInput>(
    () => ({ repository }),
    [repository],
  );
  const list = useGithubReleaseQueryV1(reads, 'listReleases', listInput);
  const latest = useGithubReleaseQueryV1(reads, 'readLatestRelease', listInput);
  const firstPage =
    list.value?.kind === 'value'
      ? (list.value.value as ForgeReleasePageV1)
      : null;
  const latestId =
    latest.value?.kind === 'value'
      ? ((latest.value.value as ForgeReleaseV1 | null)?.releaseId ?? null)
      : null;

  // Requested pages only: the first page is the shared query; Show more walks the provider cursor.
  const [walk, dispatch] = React.useReducer(
    reduceReleaseListV1,
    undefined,
    () => triagePagedPanelInitialState() as ReleaseListStateV1,
  );
  const token = React.useRef(0);
  React.useEffect(() => {
    if (!firstPage) return;
    const next = ++token.current;
    dispatch({ kind: 'refreshStarted', token: next });
    dispatch({ kind: 'pageSettled', token: next, page: firstPage });
  }, [firstPage]);
  const loadMore = React.useCallback(async (signal?: AbortSignal) => {
    if (!reads || !walk.continuation || walk.pending || signal?.aborted || context.signal.aborted) return false;
    const next = ++token.current;
    dispatch({ kind: 'requestStarted', token: next });
    const result = await reads.read('listReleases', {
      ...listInput,
      cursor: walk.continuation,
    }, signal);
    if (signal?.aborted || context.signal.aborted) return false;
    if (result.kind === 'value')
      dispatch({ kind: 'pageSettled', token: next, page: result.value });
    else if (result.kind === 'unavailable')
      dispatch({ kind: 'pageFailed', token: next, failure: result.failure });
    return result.kind === 'value';
  }, [reads, walk.continuation, walk.pending, listInput, context.signal]);

  // Freshness: when the retained rows were last confirmed by GitHub.
  const [asOf, setAsOf] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!list.status.pending && !list.status.failure && firstPage)
      setAsOf(Date.now());
  }, [list.status.pending, list.status.failure, firstPage]);

  // Route: '' list, 'compose' the editor, '<id>' a release in the Project details pane beside the list (a phone
  // pushes it), '<id>/page' that release expanded into the page. A draft opens the editor in place instead.
  const route =
    parseReleaseLocationV1(context.subPath ?? '') ??
    parseReleaseLocationV1('')!;
  // One exact read serves the open release in the pane, in the page and on return.
  const openReleaseId = route.kind === 'detail' ? route.releaseId : null;
  const detail = useReleaseDetailV1(reads, openReleaseId ? { repository, releaseId: openReleaseId } : null, true, context.signal);
  const binding = React.useMemo(
    () =>
      createReleaseLocationBindingV1({ subPath: context.subPath ?? '', host }),
    [host, context.subPath],
  );
  const navigate = React.useCallback(
    (subPath: string, backLocation = '') =>
      binding.replace({ subPath, backLocation }),
    [binding],
  );

  const [width, setWidth] = React.useState(0);
  const phone = width > 0 && width < PHONE_MAX_WIDTH;
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<'all' | 'published' | 'drafts' | 'prereleases'>('all');
  const [menuOpen, setMenuOpen] = React.useState(false);
  const assetDownloads = useReleaseAssetDownloadsV1(host, authorityKey);
  const { state: downloads, download } = assetDownloads;

  const admittedRows = walk.rows.length > 0 ? walk.rows : (firstPage?.rows ?? []);
  // Whether the open release is a draft, from the exact read or, before it lands, its list row.
  const openDraft = route.kind !== 'detail' ? false
    : detail.release?.draft ?? admittedRows.find((row) => row.releaseId === route.releaseId)?.draft ?? null;
  const paneOpen = route.kind === 'detail' && !route.fullPage && openDraft !== true;
  const pageOpen = route.kind === 'detail' && route.fullPage && openDraft !== true;
  const editing = route.kind === 'compose' || (route.kind === 'detail' && detail.release?.draft === true);
  const openLocations = route.kind === 'detail' ? releaseDetailLocationsV1(route.releaseId) : null;
  const query = search.trim().toLocaleLowerCase();
  const rows = admittedRows.filter(row => (filter === 'all' || (filter === 'published' && !row.draft)
    || (filter === 'drafts' && row.draft) || (filter === 'prereleases' && row.prerelease))
    && (query === '' || `${row.tagName} ${row.name}`.toLocaleLowerCase().includes(query)));
  const drafts = rows.filter((row) => row.draft);
  const published = rows.filter((row) => !row.draft);
  const newest = published[0] ?? null;
  const earlier = published.slice(1);
  const editor = useReleaseEditorLifetimeV1({ authorityKey, signal: context.signal, target: { repository },
    selected: route.kind === 'compose' ? (firstPage ? 'compose' : null) : detail.release?.draft ? detail.release : null,
    seed: { tagName: suggestNextReleaseTagV1(newest?.tagName ?? null), targetCommitish: target.branch ?? '', previousTagName: newest?.tagName ?? '' },
    onSaved: (release, effect) => {
      reads?.invalidateRelease(release.releaseId, effect);
      if (effect === 'created') void navigate(release.releaseId);
      if (effect === 'published') {
        const outcome = editor?.getSnapshot()?.outcome;
        if (outcome?.kind === 'confirmed' && outcome.observationWarning) {
          const warning = outcome.observationWarning;
          // Feedback is independent of the confirmed publication and normal navigation.
          void (async () => {
            try {
              await context.hostApi.notify(t('plugins.github.releases.published.refreshWarning',
                'Published. The latest release details could not be refreshed. Open the release again to refresh. ({code})',
                { code: warning.code }) + (warning.requestId ? `\nRequest ID: ${warning.requestId}` : ''),
              { severity: 'warning', signal: context.signal });
            } catch { /* Notification delivery cannot rewrite the publication receipt. */ }
          })();
        }
        void navigate('');
      }
    } });
  const helpWithCurrentFields = React.useCallback<ReleaseSessionHelpV1>(async (intent, _evidence, choice) => {
    const snapshot = intent.kind === 'notes' ? editor?.getSnapshot() : null;
    const fields = snapshot?.fields;
    const previousTagName = fields?.previousTagName ?? newest?.tagName ?? '';
    return sessionHelp?.(intent, {
      selector: intent.kind === 'notes' && intent.releaseId !== null
        ? { kind: 'existingDraft', releaseId: intent.releaseId }
        : { kind: 'proposed', tagName: fields?.tagName ?? suggestNextReleaseTagV1(newest?.tagName ?? null),
            targetCommitish: fields?.targetCommitish ?? target.branch ?? '',
            ...(previousTagName ? { previousTagName } : {}) },
      ...(fields ? { proposedNotes: fields.body } : {}),
    }, choice);
  }, [editor, sessionHelp, newest?.tagName, target.branch]);
  const boundSessionHelp = sessionHelp ? helpWithCurrentFields : undefined;
  const mountId = useSurfaceContext().mountId;
  const scope = usePluginUiEphemeralSharedScope();
  // The page's operandless controls. The person's buttons and the mounted Action run this same path and guards.
  const runCommand = async (command: ForgeReleaseMountedCommandV1, signal?: AbortSignal): Promise<ForgeReleaseMountedIntentResultV1> => {
    if (signal?.aborted || context.signal.aborted) return { status: 'unavailable' };
    const settled = (done: boolean): ForgeReleaseMountedIntentResultV1 => ({ status: done ? 'applied' : 'rejected' });
    const snapshot = editing ? editor?.getSnapshot() ?? null : null;
    switch (command) {
      case 'refresh':
        void list.refresh();
        void latest.refresh();
        if (openReleaseId) void detail.refresh();
        return { status: 'applied' };
      case 'compose':
        if (editing || hasUnsavedReleaseWorkV1(editor?.getSnapshot() ?? null)) return { status: 'rejected' };
        return settled(await navigate('compose'));
      case 'close':
        if (editing && editor && !editor.requestClose()) return { status: 'applied' };
        if (route.kind === 'list') return { status: 'unavailable' };
        return settled(await navigate(''));
      case 'discard':
        if (!editor || !snapshot?.closing) return { status: 'rejected' };
        editor.discard();
        return settled(await navigate(''));
      case 'checkStatus': {
        const outcome = snapshot?.outcome;
        if (!editor || !reads || outcome?.kind !== 'outcome_unknown' || !outcome.releaseId) return { status: 'unavailable' };
        const result = await reads.read('readRelease', { repository, releaseId: outcome.releaseId }, signal);
        if (result.kind !== 'value' || signal?.aborted || context.signal.aborted) return { status: 'unavailable' };
        editor.receive(result.value, { reconcileOutcome: true });
        return { status: 'applied' };
      }
      default:
        return editing && editor ? editor.invoke({ kind: 'command', command }) : { status: 'unavailable' };
    }
  };
  const pageAction = React.useRef<ReturnType<typeof createReleasePageActionHandlerV1> | null>(null);
  pageAction.current = createReleasePageActionHandlerV1({
    getEditor: () => editor,
    setSearch, setFilter,
    selectRelease: async (releaseId, signal) => {
      if (hasUnsavedReleaseWorkV1(editor?.getSnapshot() ?? null)) return false;
      if (signal.aborted || context.signal.aborted) return false;
      return navigate(releaseId);
    },
    // Expanded is the release as the page (Open as page); collapsing returns it to the pane.
    setExpanded: async (releaseId, value, signal) => {
      if (signal.aborted || context.signal.aborted || openDraft === true) return false;
      const locations = releaseDetailLocationsV1(releaseId);
      if (value) return pageOpen && openReleaseId === releaseId ? true
        : !hasUnsavedReleaseWorkV1(editor?.getSnapshot() ?? null) && navigate(locations.fullPageLocation.subPath, locations.fullPageLocation.backLocation);
      if (!pageOpen || openReleaseId !== releaseId) return false;
      return navigate(locations.returnLocation.subPath, locations.returnLocation.backLocation);
    },
    command: (command, signal) => runCommand(command, signal),
    loadMore: async (resource, signal) => {
      if (resource === 'list') return loadMore(signal);
      if (resource !== 'assets' || !detail.release?.assets.continuation || detail.assetsStatus.pending) return false;
      return detail.loadMoreAssets(signal);
    },
  });
  React.useEffect(() => scope && mountId ? bindReleaseMountedActionsV1(scope, mountId,
    (operation, signal) => pageAction.current?.(operation, signal) ?? Promise.resolve({ status: 'unavailable' }), context.signal) : undefined,
  [scope, mountId, authorityKey, context.signal]);
  React.useEffect(() => {
    if (!mountId || context.signal.aborted) return;
    const publish = () => {
      if (context.signal.aborted) return;
      const snapshot = editing ? editor?.getSnapshot() ?? null : null;
      host.publishCurrentUiContext({ detail: { mountId, search, filter, selectedReleaseId: openReleaseId,
        presentation: editing ? 'editor' : paneOpen ? 'pane' : pageOpen ? 'page' : 'list',
        ...(snapshot ? { fields: snapshot.fields, preview: snapshot.preview, dirty: snapshot.dirty, closing: snapshot.closing,
          conflict: snapshot.conflict !== null, resultUnknown: snapshot.outcome?.kind === 'outcome_unknown' } : {}) },
        ...(scope ? { commands: currentReleaseCommandsV1({ t, mountId, route, snapshot, editing, paneOpen, pageOpen }) } : {}) });
    };
    const clear = () => host.publishCurrentUiContext(null);
    publish();
    const unsubscribe = editor?.subscribe(publish);
    context.signal.addEventListener('abort', clear, { once: true });
    return () => { unsubscribe?.(); context.signal.removeEventListener('abort', clear); clear(); };
  }, [host, mountId, scope, context.signal, editor, search, filter, route.subPath, t, editing, paneOpen, pageOpen, openReleaseId]);
  const failure = list.status.failure;
  const hydrated = firstPage !== null;
  const repositoryName = repository.repository;
  const openOnGithub = React.useCallback(
    (url: string) => {
      void host.openExternalLink(url).catch(() => {});
    },
    [host],
  );
  const releasesUrl = `${repository.deployment.replace(/\/$/u, '')}/${repositoryName}/releases`;
  const signIn = React.useCallback(() => {
    void host
      .openConnectedAccounts({ service: GITHUB_ACCOUNT_SERVICE })
      .catch(() => {});
  }, [host]);

  // The release expanded into the page returns to its details pane (Return). A phone has the shell's own back.
  const openRelease = route.kind === 'detail' && detail.release && !detail.release.draft ? detail.release : null;
  const toolbar = (
    <Row gap="small" align="center" style={{ minHeight: 36 }}>
      {pageOpen && openLocations && !phone ? (
        <>
          <ReleaseEdgeAligned>
            <Button
              variant="plain"
              size="small"
              icon={<Icon name="back" size="small" />}
              title={t('plugins.github.releases.toolbar.return', 'Releases')}
              onPress={() => {
                void navigate(openLocations.returnLocation.subPath, openLocations.returnLocation.backLocation);
              }}
            />
          </ReleaseEdgeAligned>
          <Text variant="meta" tone="muted" value={repositoryName} numberOfLines={1} />
        </>
      ) : (
        <>
          <Icon name="tag" size="small" tone="secondary" />
          <Text variant="label" value={repositoryName} numberOfLines={1} />
        </>
      )}
      <Stack grow gap="none" />
      {!phone ? (
        <Text
          variant="meta"
          tone="muted"
          value={
            list.status.pending && !hydrated
              ? t(
                  'plugins.github.releases.toolbar.reading',
                  'Reading releases…',
                )
              : asOf === null
                ? ''
                : failure
                  ? t('plugins.github.releases.toolbar.asOf', 'As of {time}', {
                      time: new Intl.DateTimeFormat(locale, {
                        hour: 'numeric',
                        minute: '2-digit',
                      }).format(asOf),
                    })
                  : t(
                      'plugins.github.releases.toolbar.updated',
                      'Updated {day}',
                      {
                        day:
                          Date.now() - asOf < 60_000
                            ? t(
                                'plugins.github.releases.toolbar.justNow',
                                'just now',
                              )
                            : (formatReleaseDayV1(
                                new Date(asOf).toISOString(),
                                locale,
                              ) ?? ''),
                      },
                    )
          }
        />
      ) : null}
      <IconButton
        accessibilityLabel={t(
          'plugins.github.releases.toolbar.refresh',
          'Refresh releases',
        )}
        busy={(list.status.pending && hydrated) || (openRelease !== null && detail.status.pending)}
        icon={<Icon name="refresh" size="small" />}
        onPress={() => {
          void runCommand('refresh');
        }}
      />
      <Menu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        trigger={t('plugins.github.releases.toolbar.more', 'More')}
        triggerIcon="more"
        triggerAccessibilityLabel={t('plugins.github.releases.toolbar.moreLabel', 'More release actions')}
        items={[
          ...(openRelease ? [
            { id: 'view', label: t('plugins.github.releases.toolbar.viewOnGithub', 'View release on GitHub'), icon: 'external' as const },
            { id: 'copy', label: t('plugins.github.releases.toolbar.copyLink', 'Copy link'), icon: 'copy' as const },
          ] : []),
          { id: 'open', label: t('plugins.github.releases.toolbar.openOnGithub', 'Open releases on GitHub'), icon: 'external' as const },
        ]}
        onSelect={(id) => {
          setMenuOpen(false);
          if (id === 'view' && openRelease) openOnGithub(openRelease.webUrl);
          else if (id === 'copy' && openRelease) void host.writeClipboard(openRelease.webUrl).catch(() => {});
          else if (id === 'open') openOnGithub(releasesUrl);
        }}
      />
    </Row>
  );

  // Compose replaces the Next release card in place (the b1→b2 signature moment).
  const composing = route.kind === 'compose';
  const composer =
    composing ||
    (route.kind === 'detail' && detail.release?.draft) ? (
      <ReleaseComposer
        key={route.kind === 'detail' ? route.releaseId : 'new'}
        target={{ repository }}
        host={host}
        assetDownloads={assetDownloads}
        sessionHelp={boundSessionHelp}
        locale={locale}
        phone={phone}
        editor={editor}
        previousTag={newest?.tagName ?? ''}
        onCommand={(command) => {
          void runCommand(command);
        }}
        onOpenGithub={openOnGithub}
        onSignIn={signIn}
        loadMoreAssets={detail.loadMoreAssets}
      />
    ) : null;

  const next = composer ?? (
    <NextReleaseCard
      phone={phone}
      newest={newest}
      draft={drafts[0] ?? null}
      sessionHelp={boundSessionHelp}
      locale={locale}
      onDraft={() => {
        void runCommand('compose');
      }}
      onOpenDraft={(draft) => {
        void navigate(draft.releaseId);
      }}
    />
  );

  const content = (() => {
    // The expanded page and a draft's editor stand on the exact read; a release in the pane keeps the list beside it.
    const exactRoute = route.kind === 'detail' && !paneOpen;
    const contentFailure = exactRoute
      ? (!detail.release ? detail.status.failure : null)
      : (!hydrated ? failure : null);
    if (contentFailure) {
      const copy = failureCopy(t, contentFailure, repositoryName);
      return (
        <Stack style={{ paddingTop: 48 }}>
          <ErrorState
            kind={copy.kind}
            title={copy.title}
            description={copy.description}
            details={[contentFailure.code, contentFailure.detail, contentFailure.requestId].filter(Boolean).join('\n')}
            {...(contentFailure.class === 'authentication'
              ? {
                  action: (
                    <Button
                      title={t(
                        'plugins.github.releases.state.signIn.action',
                        'Sign in again',
                      )}
                      onPress={signIn}
                    />
                  ),
                }
              : { onRetry: () => exactRoute ? detail.refresh() : list.refresh() })}
          />
        </Stack>
      );
    }
    if (exactRoute ? !detail.release : !hydrated) return <ReleasesLoading />;
    // A phone pushes the editor as its own page, in the same order.
    if (phone && composer) return composer;
    if (pageOpen && detail.release) {
      const release = detail.release;
      return (
        <Stack gap="large">
          <ReleaseHeadline
            release={release}
            latest={release.releaseId === latestId}
          />
          <ReleaseByline release={release} locale={locale} />
          <ReleaseNotes body={release.body} />
          <ReleaseAssets
            release={release}
            locale={locale}
            compact={phone}
            downloads={downloads}
            onShowAll={() => { void detail.loadMoreAssets(); }}
            onDownload={(asset) => {
              void download(release, asset);
            }}
          />
        </Stack>
      );
    }
    if (admittedRows.length === 0 && !composer) {
      return (
        <Stack style={{ paddingTop: 48 }}>
          <EmptyState
            layout="page"
            icon="tag"
            title={t(
              'plugins.github.releases.empty.title',
              'Ship {name}’s first release',
              { name: repositoryName.split('/').pop() ?? repositoryName },
            )}
            description={t(
              'plugins.github.releases.empty.body',
              'A release names a version, says what changed and holds the downloads. Pick a tag, generate the notes, then edit them. Nothing is published until you choose Publish.',
            )}
            action={
              <Row gap="small" align="center" wrap justify="center">
                <ReleaseSessionHelpButton
                  help={boundSessionHelp}
                  intent={{ kind: 'notes', releaseId: null }}
                />
                <Button
                  title={t(
                    'plugins.github.releases.empty.action',
                    'Draft first release',
                  )}
                  icon={<Icon name="tag" size="small" />}
                  onPress={() => {
                    void navigate('compose');
                  }}
                />
              </Row>
            }
          />
        </Stack>
      );
    }
    return (
      <Stack gap="xlarge">
        {next}
        {newest ? (
          <Stack gap="medium" testID="github-releases-newest">
            <Text
              variant="heading"
              value={t('plugins.github.releases.newest', 'Newest')}
            />
            <Stack gap="small">
              <ReleaseHeadline
                release={newest}
                latest={newest.releaseId === latestId}
              />
              <ReleaseByline release={newest} locale={locale} />
            </Stack>
            <ReleaseNotes body={newest.body} clip />
            <ReleaseAssets
              release={newest}
              locale={locale}
              compact={phone}
              downloads={downloads}
              onDownload={(asset) => {
                void download(newest, asset);
              }}
            />
          </Stack>
        ) : null}
        {earlier.length > 0 || drafts.length > 1 ? (
          <ItemGroup
            title={t('plugins.github.releases.earlier', 'Earlier')}
            action={
              !phone ? (
                <Text
                  variant="meta"
                  tone="muted"
                  value={t(
                    'plugins.github.releases.earlier.order',
                    'Newest first',
                  )}
                />
              ) : undefined
            }
          >
            {[...drafts.slice(1), ...earlier].map((release) => (
              <EarlierRow
                key={release.releaseId}
                release={release}
                latest={release.releaseId === latestId}
                locale={locale}
                phone={phone}
                compact={phone || width < COMPACT_ROW_MAX_WIDTH}
                selected={paneOpen && openReleaseId === release.releaseId}
                onPress={() => {
                  // A published release opens in the details pane (pushed on a phone); a draft opens its editor.
                  void navigate(release.releaseId);
                }}
              />
            ))}
            {walk.canLoadMore ? (
              <Item
                title={t('plugins.github.releases.earlier.more', 'Show more')}
                busy={walk.pending}
                onPress={() => {
                  void loadMore();
                }}
              />
            ) : null}
          </ItemGroup>
        ) : null}
      </Stack>
    );
  })();

  const paneRelease = paneOpen ? detail.release : null;
  const paneIdentity = paneRelease === null ? null : projectGithubReleaseIdentityV1(paneRelease);
  const pane = (
    <DetailsPane
      open={paneOpen}
      title={paneIdentity ? paneIdentity.name ?? paneIdentity.tagName ?? t('plugins.github.releases.draft.unnamed', 'Draft release')
        : t('plugins.github.releases.pane.title', 'Release')}
      {...(paneIdentity?.name && paneIdentity.tagName ? { subtitle: paneIdentity.tagName } : {})}
      leading={<Icon name="tag" size="small" tone="secondary" />}
      actions={openLocations === null ? undefined : (
        <DetailsPaneOpenAsPageButton
          testID="github-release-open-as-page"
          onPress={() => navigate(openLocations.fullPageLocation.subPath, openLocations.fullPageLocation.backLocation)}
        />
      )}
      onClose={() => {
        void runCommand('close');
      }}
      testID="github-release-pane"
    >
      <ScrollArea>
        <Stack gap="large" style={{ paddingTop: theme.spacing.small, paddingBottom: theme.spacing.xlarge }}>
          {paneRelease ? (
            <>
              <Stack gap="small">
                <ReleaseMarks release={paneRelease} latest={paneRelease.releaseId === latestId} />
                <ReleaseByline release={paneRelease} locale={locale} />
              </Stack>
              <ReleaseNotes body={paneRelease.body} />
              <ReleaseAssets
                release={paneRelease}
                locale={locale}
                compact
                downloads={downloads}
                onShowAll={() => { void detail.loadMoreAssets(); }}
                onDownload={(asset) => {
                  void download(paneRelease, asset);
                }}
              />
            </>
          ) : detail.status.failure ? (
            <ErrorState
              layout="line"
              title={t('plugins.github.releases.pane.failed', 'Couldn’t read this release')}
              details={[detail.status.failure.code, detail.status.failure.detail, detail.status.failure.requestId].filter(Boolean).join('\n')}
              onRetry={() => { void detail.refresh(); }}
            />
          ) : (
            <LoadingState rows={4} title={t('plugins.github.releases.pane.reading', 'Reading this release')} />
          )}
        </Stack>
      </ScrollArea>
    </DetailsPane>
  );

  return (
    <Stack grow gap="none">
    <ScrollArea onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <Stack
        gap="large"
        style={{
          width: '100%',
          maxWidth: COLUMN_MAX_WIDTH,
          alignSelf: 'center',
          paddingHorizontal: phone
            ? theme.spacing.medium
            : theme.spacing.xlarge,
          paddingTop: theme.spacing.large,
          paddingBottom: 64,
        }}
      >
        {toolbar}
        {hydrated && failure ? (
          <FreshnessLine
            asOf={asOf}
            reason={freshnessReason(t, failure)}
            tone="warning"
            action={
              failure.class === 'authentication'
                ? {
                    label: t(
                      'plugins.github.releases.state.signIn.action',
                      'Sign in again',
                    ),
                    onPress: signIn,
                  }
                : {
                    label: t('plugins.github.releases.retry', 'Retry'),
                    onPress: () => {
                      void list.refresh();
                    },
                  }
            }
          />
        ) : null}
        {walk.kind === 'ready' && walk.failure && hydrated ? (
          <Banner
            presentation="strip"
            tone="warning"
            title={t(
              'plugins.github.releases.more.failed',
              'Couldn’t read more releases',
            )}
            action={
              <Button
                variant="plain"
                size="small"
                title={t('plugins.github.releases.retry', 'Retry')}
                onPress={() => {
                  void loadMore();
                }}
              />
            }
          />
        ) : null}
        {content}
      </Stack>
    </ScrollArea>
    {pane}
    </Stack>
  );
}

/** What an agent can press right now: the same buttons the person sees, as mounted-Action commands. */
function currentReleaseCommandsV1(input: Readonly<{
  t: ReturnType<typeof usePluginTranslation>;
  mountId: string;
  route: ReleaseRouteV1;
  snapshot: ReleaseEditorSnapshotV1 | null;
  editing: boolean;
  paneOpen: boolean;
  pageOpen: boolean;
}>): NonNullable<PluginUiContextEnrichmentV1['commands']> {
  const { t, mountId, route, snapshot } = input;
  const entry = (title: string, operation: ForgeReleaseMountedIntentOperationV1) => ({
    title,
    command: { kind: 'executeAction' as const, action: GITHUB_RELEASE_MOUNTED_ACTION_ID_V1, input: { mountId, operation } },
  });
  const command = (title: string, name: ForgeReleaseMountedCommandV1) => entry(title, { kind: 'command', command: name });
  const commands: ReturnType<typeof entry>[] = [];
  if (input.editing && snapshot) {
    commands.push(entry(t('plugins.github.releases.compose.preview', 'Preview'), { kind: 'setPreview', value: !snapshot.preview }));
    if (snapshot.closing) {
      commands.push(command(t('plugins.github.releases.compose.discard.confirm', 'Discard'), 'discard'));
      commands.push(command(t('plugins.github.releases.compose.discard.keep', 'Keep editing'), 'keepEditing'));
    } else commands.push(command(t('plugins.github.releases.compose.close', 'Close the editor'), 'close'));
    if (snapshot.conflict) commands.push(command(t('plugins.github.releases.compose.conflict.useRemote', 'Use GitHub’s version'), 'useRemote'));
    if (snapshot.outcome?.kind === 'outcome_unknown' && snapshot.outcome.releaseId)
      commands.push(command(t('plugins.github.releases.compose.unknown.check', 'Check status'), 'checkStatus'));
    if (snapshot.busy === null && snapshot.fields.tagName.trim() && snapshot.outcome?.kind !== 'outcome_unknown')
      commands.push(command(t('plugins.github.releases.compose.generate', 'Generate from changes'), 'generate'));
  }
  if (route.kind === 'detail' && input.paneOpen) {
    commands.push(entry(t('plugins.github.releases.pane.openAsPage', 'Open as page'), { kind: 'setExpanded', releaseId: route.releaseId, value: true }));
    commands.push(command(t('plugins.github.releases.pane.close', 'Close release details'), 'close'));
  }
  if (route.kind === 'detail' && input.pageOpen)
    commands.push(entry(t('plugins.github.releases.page.return', 'Return to the release details'), { kind: 'setExpanded', releaseId: route.releaseId, value: false }));
  if (route.kind === 'list') commands.push(command(t('plugins.github.releases.next.draft', 'Draft release'), 'compose'));
  commands.push(command(t('plugins.github.releases.toolbar.refresh', 'Refresh releases'), 'refresh'));
  return commands;
}

/** The Next-release card's text and its actions: side by side on a wide page, text over actions on a phone. */
function CardFrame(props: Readonly<{ phone: boolean; children: React.ReactNode }>): React.ReactElement {
  return props.phone ? (
    <Stack gap="medium" align="stretch">{props.children}</Stack>
  ) : (
    <Row gap="large" align="center" wrap>{props.children}</Row>
  );
}

/** A phone stacks the primary over the session help, each across the card; a wide page keeps them in one row. */
function CardActions(
  props: Readonly<{ phone: boolean; help: React.ReactElement; primary: React.ReactElement }>,
): React.ReactElement {
  return props.phone ? (
    <Stack gap="small" align="stretch">{props.primary}{props.help}</Stack>
  ) : (
    <Row gap="small" align="center" wrap>{props.help}{props.primary}</Row>
  );
}

function NextReleaseCard(
  props: Readonly<{
    phone: boolean;
    newest: ForgeReleaseV1 | null;
    draft: ForgeReleaseV1 | null;
    locale: string;
    sessionHelp: ReleaseSessionHelpV1 | undefined;
    onDraft(): void;
    onOpenDraft(draft: ForgeReleaseV1): void;
  }>,
): React.ReactElement {
  const t = usePluginTranslation();
  const theme = usePluginTheme();
  const card = {
    borderRadius: theme.radii.panel,
    backgroundColor: theme.colors.elevatedSurface,
    padding: props.phone ? theme.spacing.medium : theme.spacing.large,
  } as const;
  if (props.draft) {
    const draft = props.draft;
    const identity = projectGithubReleaseIdentityV1(draft);
    const saved =
      formatReleaseDayV1(draft.updatedAt ?? draft.createdAt, props.locale) ??
      '';
    return (
      <Stack gap="medium" style={card} testID="github-releases-draft-card">
        <CardFrame phone={props.phone}>
          <Stack grow gap="xsmall" style={{ minWidth: props.phone ? 0 : 240 }}>
            <Text
              variant="meta"
              tone="secondary"
              value={t(
                'plugins.github.releases.draft.eyebrow',
                'Draft · only people with write access see it',
              )}
            />
            <Row gap="small" align="center" wrap>
              {identity.name ? (
                <>
                  {identity.tagName === null ? null : <Text variant="code" value={identity.tagName} />}
                  <Text variant="label" value={identity.name} />
                </>
              ) : (
                <Text variant="label" value={identity.tagName ?? t('plugins.github.releases.draft.unnamed', 'Draft release')} />
              )}
            </Row>
            <Text
              variant="meta"
              tone="muted"
              value={
                draft.author
                  ? t(
                      'plugins.github.releases.draft.savedBy',
                      'Saved on GitHub {day} by {author} · from {target}',
                      {
                        day: saved,
                        author: draft.author,
                        target: formatReleaseTargetV1(draft.targetCommitish),
                      },
                    )
                  : t(
                      'plugins.github.releases.draft.saved',
                      'Saved on GitHub {day} · from {target}',
                      { day: saved, target: formatReleaseTargetV1(draft.targetCommitish) },
                    )
              }
            />
          </Stack>
          <CardActions
            phone={props.phone}
            help={
              <ReleaseSessionHelpButton
                help={props.sessionHelp}
                intent={{ kind: 'notes', releaseId: draft.releaseId }}
              />
            }
            primary={
              <Button
                title={t('plugins.github.releases.draft.open', 'Open draft')}
                onPress={() => props.onOpenDraft(draft)}
              />
            }
          />
        </CardFrame>
      </Stack>
    );
  }
  const newestDay = props.newest
    ? formatReleaseDayV1(
        props.newest.publishedAt ?? props.newest.createdAt,
        props.locale,
      )
    : null;
  return (
    <Stack gap="medium" style={card} testID="github-releases-next-card">
      <CardFrame phone={props.phone}>
        <Stack grow gap="xsmall" style={{ minWidth: props.phone ? 0 : 240 }}>
          <Text
            variant="meta"
            tone="secondary"
            value={t('plugins.github.releases.next.eyebrow', 'Next release')}
          />
          {props.newest ? (
            <Row gap="small" align="center" wrap>
              <Text
                variant="label"
                value={t('plugins.github.releases.next.after', 'Next after')}
              />
              <Text variant="code" value={props.newest.tagName} />
            </Row>
          ) : (
            <Text
              variant="label"
              value={t(
                'plugins.github.releases.next.first',
                'Your first release',
              )}
            />
          )}
          {newestDay ? (
            <Text
              variant="meta"
              tone="muted"
              value={t(
                'plugins.github.releases.next.newest',
                'Newest release published {day}',
                { day: newestDay },
              )}
            />
          ) : null}
        </Stack>
        <CardActions
          phone={props.phone}
          help={
            <ReleaseSessionHelpButton
              help={props.sessionHelp}
              intent={{ kind: 'draft' }}
            />
          }
          primary={
            <Button
              title={t('plugins.github.releases.next.draft', 'Draft release')}
              icon={<Icon name="tag" size="small" />}
              onPress={props.onDraft}
            />
          }
        />
      </CardFrame>
    </Stack>
  );
}

function EarlierRow(
  props: Readonly<{
    release: ForgeReleaseV1;
    latest: boolean;
    locale: string;
    phone: boolean;
    /** Narrow column (a phone, or a desktop beside a side pane): the right column keeps only the date. */
    compact: boolean;
    /** The release open in the details pane beside the list. */
    selected: boolean;
    onPress(): void;
  }>,
): React.ReactElement {
  const t = usePluginTranslation();
  const { release } = props;
  const { name, tagName } = projectGithubReleaseIdentityV1(release);
  const numbers = new Intl.NumberFormat(props.locale);
  const day =
    formatReleaseDayV1(
      release.draft
        ? (release.updatedAt ?? release.createdAt)
        : (release.publishedAt ?? release.createdAt),
      props.locale,
    ) ?? '';
  const assets = release.assets.rows.length;
  const total = release.assets.rows.every(
    (row) => row.downloadCount !== undefined,
  )
    ? release.assets.rows.reduce(
        (sum, row) => sum + (row.downloadCount ?? 0),
        0,
      )
    : null;
  const mark = release.draft
    ? t('plugins.github.releases.mark.draft', 'Draft')
    : props.latest
      ? t('plugins.github.releases.mark.latest', 'Latest')
      : release.prerelease
        ? t('plugins.github.releases.mark.prerelease', 'Pre-release')
        : null;
  const detail = props.compact
    ? day
    : [
        assets === 0
          ? t('plugins.github.releases.row.noAssets', 'No assets')
          : assets === 1
            ? t('plugins.github.releases.row.assetsOne', '{count} asset', {
                count: numbers.format(assets),
              })
            : t('plugins.github.releases.row.assets', '{count} assets', {
                count: numbers.format(assets),
              }),
        total === null || total === 0
          ? null
          : total === 1
            ? t('plugins.github.releases.row.downloadsOne', '{count} download', {
                count: numbers.format(total),
              })
            : t('plugins.github.releases.row.downloads', '{count} downloads', {
                count: numbers.format(total),
              }),
        day,
      ]
        .filter(Boolean)
        .join('  ·  ');
  return (
    <Item
      icon={<Icon name="tag" size="small" tone="secondary" />}
      accessibilityLabel={[tagName, name].filter(Boolean).join(' ') || t('plugins.github.releases.draft.unnamed', 'Draft release')}
      {...(mark === null ? {} : { accessibilityHint: mark })}
      detail={detail}
      onPress={props.onPress}
      selected={props.selected}
    >
      <Row gap="small" align="center" wrap style={{ minWidth: 0 }}>
        {tagName === null ? null : <Stack gap="none" style={{ flexShrink: 0 }}>
          <Text variant="code" value={tagName} numberOfLines={1} />
        </Stack>}
        {name || tagName === null ? (
          <Stack gap="none" style={{ flexShrink: 1, minWidth: 0 }}>
            <Text value={name ?? t('plugins.github.releases.draft.unnamed', 'Draft release')} numberOfLines={1} />
          </Stack>
        ) : null}
        {mark ? (
          <Stack gap="none" style={{ flexShrink: 0 }}>
            <Badge value={mark} />
          </Stack>
        ) : null}
      </Row>
    </Item>
  );
}

function ReleasesLoading(): React.ReactElement {
  const t = usePluginTranslation();
  return (
    <LoadingState
      rows={6}
      title={t('plugins.github.releases.loading', 'Reading releases')}
    />
  );
}

export type { ReleaseRouteV1 };

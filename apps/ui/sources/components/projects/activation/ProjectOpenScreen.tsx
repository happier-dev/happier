import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { SessionDraftAddressV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { randomUUID } from '@/platform/randomUUID';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { ensureSessionDraftRepositoryHydrated, flushSessionDraftLocally } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import {
  useLocalSearchParams,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { NavigationBackChromeProvider, useNavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { usePageBackControl } from '@/components/ui/layout/usePageBackControl';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import {
  useActiveServerAccountScope,
  useAllMachines,
  useProjectAccountRows,
  useWorkspaceRefs,
} from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { isProjectAccountRowsCensusComplete } from '@/sync/store/domains/projectAccountRows';
import { formatResetAtTime } from '@/utils/time/formatResetAtTime';
import {
  getMachineDisplayName,
} from '@/utils/sessions/machineUtils';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { resolveMachineActionCandidates } from '@/utils/sessions/resolveMachineActionCandidates';
import { getMachineSentenceName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { useProjectSourceAddress } from '../sources/useProjectSourceAddress';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { WorkspaceActivationSyncFields } from '@/components/workspaces/activation/WorkspaceActivationEditor';

import { ProjectRefSelect } from '../ProjectRefSelect';
import { formatProjectSourceAddress } from '../sources/projectSourceAddress';
import { groupProjectSources } from '../sources/ProjectSourcesRail';
import { useProjectSources } from '../sources/useProjectSources';
import {
  ProjectOpenUseSection,
  ProjectOpenWhereRow,
  type ProjectOpenWhereStatus,
} from './ProjectOpenChoiceRows';
import {
  buildProjectOpenDraft,
  buildProjectOpenInput,
  projectOpenChoiceStateFromDraft,
  resolveProjectOpenUseOptions,
  resolveProjectOpenDefaults,
  suggestProjectOpenDestination,
  type ProjectOpenSubject,
  type ProjectOpenUse,
} from './projectOpenChoices';
import { readProjectOpenRouteDraft } from './projectOpenRoute';
import { ProjectOpenSourceChooser, ProjectOpenSourceSheet, useProjectSourceTeamName } from './ProjectOpenSourceChooser';
import { useProjectOpen } from './useProjectOpen';
import { projectOpenRefusalPresentation } from './projectOpenRefusalPresentation';
import { presentProjectSourceAddressRefusal } from '../sources/resolveProjectSourceAddress';

/** The source list's width beside the choices (lab `p-open` OPEN), and the narrowest choices column. */
const SOURCE_LIST_WIDTH_PX = 300;
const CHOICES_MIN_WIDTH_PX = 420;

function readParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() ? first : null;
}

type ProjectOpenHostProps = Readonly<{
  onClose?: () => void;
  /** The dialog host (`showProjectOpenDialog`): its address, instead of the page route's own params. */
  routeParams?: Readonly<Record<string, string>>;
  /** The dialog host's card chrome: the footer goes in its footer slot. */
  setChrome?: CustomModalInjectedProps['setChrome'];
}>;

/**
 * Open a Project without starting an Agent (plan 11, lab `p-open`): pick a Source (or a folder) on
 * the left, then where and how to open it on the right; one primary Open project. Choosing never
 * materializes anything — only the confirmation runs the canonical `projects.open` Action. One
 * component for every host: the desktop dialog (`showProjectOpenDialog`), the page, and the phone's
 * pushed page with choice sheets.
 */
export const ProjectOpenScreen = React.memo(function ProjectOpenScreen(
  props: ProjectOpenHostProps,
) {
  const scope = useActiveServerAccountScope();
  const routeParams = useLocalSearchParams<Record<string, string | string[]>>();
  const params = props.routeParams ?? routeParams;
  const requestedDraftId = readParam(params.draftId);
  const address = requestedDraftId ? SessionDraftAddressV2Schema.safeParse({ kind: 'projectOpen', draftId: requestedDraftId }) : null;
  const [newDraftId] = React.useState(randomUUID);
  const draftId = address?.success && address.data.kind === 'projectOpen' ? address.data.draftId : newDraftId;
  const scopeKey = scope ? `${scope.serverId}:${scope.accountId}` : null;
  const [hydration, setHydration] = React.useState<{ scopeKey: string; ready: boolean } | null>(null);
  React.useEffect(() => {
    if (!scope || !scopeKey) return;
    let mounted = true;
    void (async () => {
      await flushSessionDraftLocally({ scope });
      // Remote unavailability does not discard or hide locally retained chooser state.
      await ensureSessionDraftRepositoryHydrated(scope).catch(() => {});
    })().then(() => {
      if (mounted) setHydration({ scopeKey, ready: true });
    }, () => { if (mounted) setHydration({ scopeKey, ready: false }); });
    return () => { mounted = false; };
  }, [scope?.serverId, scope?.accountId, scopeKey, draftId]);
  if (!scope) return <ItemList testID="projects.open.signedOut">{null}</ItemList>;
  if (address && !address.success) return <AttentionBanner testID="projects.open.invalidDraftAddress" title={t('projects.open.unsupported')} details={['invalid_draft_address']} />;
  if (!hydration || hydration.scopeKey !== scopeKey) return <AttentionBanner testID="projects.open.resolving" tone="neutral" title={t('projects.open.resolving')} />;
  if (!hydration.ready) return <AttentionBanner testID="projects.open.draftUnavailable" title={t('projects.open.unsupported')} details={['project_open_draft_unavailable']} />;
  return <ProjectOpenForm key={`${scope.serverId}:${scope.accountId}:${draftId}`} scope={scope} draftId={draftId}
    seedIfMissing={!requestedDraftId} onClose={props.onClose} routeParams={props.routeParams} setChrome={props.setChrome} />;
});

function readMachineHomeDir(machine: Readonly<{ metadata?: unknown }> | null | undefined): string | null {
  const homeDir = (machine?.metadata as { homeDir?: unknown } | null | undefined)?.homeDir;
  return typeof homeDir === 'string' && homeDir ? homeDir : null;
}

const ProjectOpenForm = React.memo(function ProjectOpenForm(
  props: ProjectOpenHostProps & Readonly<{ scope: ServerAccountScope; draftId: string; seedIfMissing: boolean }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const routeParams = useLocalSearchParams<Record<string, string | string[]>>();
  const params = props.routeParams ?? routeParams;
  const dialog = props.setChrome !== undefined;
  const seed = React.useMemo(() => readProjectOpenRouteDraft(params), [params]);
  const machines = useAllMachines();
  const presenceNowMs = useMachinePresenceNowMs(machines);
  const reachabilityRevision = useMachineReachabilityRevision();
  const checkouts = useWorkspaceRefs();
  const { state: catalog, controller: catalogController } = useProjectSources(
    props.scope,
  );
  const teamName = useProjectSourceTeamName(props.scope.serverId);

  const candidates = React.useMemo(
    () => resolveMachineActionCandidates(props.scope, machines, { onlineOnly: false, nowMs: presenceNowMs }),
    [machines, props.scope, presenceNowMs, reachabilityRevision],
  );
  const machineNames = React.useMemo(() => resolveMachineDisplayNames(candidates), [candidates]);
  const [query, setQuery] = React.useState('');
  const requestedDraftId = readParam(params.draftId);
  const draftId = props.draftId;
  const open = useProjectOpen({ scope: props.scope, draftId, seedIfMissing: props.seedIfMissing, initialDraft: seed ?? undefined, onOpened: opened });
  const draftRef = React.useRef(open.draft);
  draftRef.current = open.draft;
  React.useEffect(() => {
    // The page carries its draft in its own address; a dialog's draft is addressed by its id alone.
    if (!requestedDraftId && !dialog) router.replace({ pathname: '/projects/open', params: { draftId, serverId: props.scope.serverId } } as never);
  }, [dialog, draftId, requestedDraftId, props.scope.serverId, router]);
  const [width, setWidth] = React.useState<number | null>(null);

  const machineId = open.draft?.machineId ?? null;
  const machinePresence = useMachinePresenceSummary(props.scope.serverId, machineId);
  const machine =
    machines.find((candidate) => candidate.id === machineId) ?? null;
  const machineHomeDir = readMachineHomeDir(machine);
  const storedChoice = projectOpenChoiceStateFromDraft(open.draft ?? { serverId: props.scope.serverId },
    Array.isArray(checkouts) ? checkouts : [], machineHomeDir);
  // The form stands on the choices owner's default until the person chooses: shown, and written with the
  // next edit or the Open itself. It is only written once the census is complete, so a way chosen while
  // the checkouts were still loading (a clone, say) never sticks as if the person had picked it.
  const rowsCensusComplete = isProjectAccountRowsCensusComplete(useProjectAccountRows());
  const storedDefaults = resolveProjectOpenDefaults(storedChoice);
  const choiceBase = { ...storedChoice, ...storedDefaults };
  const defaultsPending = Object.keys(storedDefaults).length > 0;
  const { subject, ref, branch } = choiceBase;
  const options = resolveProjectOpenUseOptions(choiceBase);
  const effectiveUse = choiceBase.use;
  const effectiveDestination = choiceBase.destination;
  const draft = open.draft;
  const edit = (patch: Partial<typeof choiceBase>) => {
    let next = { ...choiceBase, ...patch };
    if (patch.machineId !== undefined) {
      next = { ...next, machineHomeDir: readMachineHomeDir(machines.find((candidate) => candidate.id === patch.machineId)) };
    }
    // Each choice leaves the form on a valid way to open (kept when the person chose it), and a clone or
    // copy starts at the suggested folder (or follows it to a new machine). Both answer the person's own
    // choice; typing a folder or a branch never re-suggests over it.
    if (patch.destination === undefined && patch.branch === undefined) {
      // The form always stands on a valid way to open (the choices owner names it), never on nothing.
      if (rowsCensusComplete) next = { ...next, ...resolveProjectOpenDefaults(next) };
      const suggested = suggestProjectOpenDestination(choiceBase);
      if ((next.use === 'clone' || next.use === 'copy')
        && (!next.destination.trim() || next.destination === suggested)) {
        next = { ...next, destination: suggestProjectOpenDestination(next) };
      }
    }
    open.setDraft(buildProjectOpenDraft(next));
  };
  const setSubject = (next: ProjectOpenSubject) => edit({ subject: next, checkoutId: null, checkoutAddress: null });
  const setMachineId = (next: string) => {
    edit({ machineId: next });
    // A clone's address that did not resolve yet is read again by the Machine the person chose.
    const pending = repositoryAddress.resolution;
    if (!subject && pending.kind !== 'idle' && pending.kind !== 'resolved' && pending.address) void repositoryAddress.resolve(pending.address, next);
  };
  const setRef = (next: string | null) => edit({ ref: next });
  const setSubdir = (next: string) => edit({ subdir: next });
  const setUse = (next: ProjectOpenUse) => edit({ use: next });
  const setBranch = (next: string) => edit({ branch: next });
  const setDestination = (next: string) => edit({ destination: next });
  // "Clone a repository…": with only the clone intent and no Source yet, the address is the first field;
  // the Machine's hosting owner reads it (the same reading as a new Source) and the repository becomes the subject.
  const repositoryAddress = useProjectSourceAddress(props.scope, (selector) => setSubjectRef.current({ kind: 'repository', selector }));
  const setSubjectRef = React.useRef(setSubject);
  setSubjectRef.current = setSubject;

  // The Machine in a sentence: its resolved name, "this machine" while it loads or is locked, else the id.
  function sentenceMachineName(machineId: string): string {
    const known = machines.find((candidate) => candidate.id === machineId);
    return known ? getMachineSentenceName(known, machineNames.get(machineId)) : machineId;
  }

  function opened(result: Extract<OpenProjectResultV1, { kind: 'opened' }>) {
      const machineName = sentenceMachineName(result.workspace.machineId);
      const projectName = result.directory.split(/[\\/]/u).filter(Boolean).pop() ?? result.directory;
      // One notice says what is true where the person lands: no agent runs, and setup's own state.
      publishPresentationNotice({
        key: `project-opened:${result.workspace.workspaceId}`,
        message: result.setup === 'failed'
          ? `${t('projects.open.setupFailed', { project: projectName })} ${t('projects.open.filesKept')}`
          : result.setup === 'approvalRequired'
            ? t('projects.open.setupPending')
            : t('projects.open.opened', { machine: machineName }),
        severity: result.setup === 'failed' ? 'warning' : 'info',
      });
      props.onClose?.();
  }

  const groups = groupProjectSources({
    sources: catalog.rows,
    accountId: props.scope.accountId,
    teamName,
  });
  const twoPanes =
    width === null || width >= SOURCE_LIST_WIDTH_PX + CHOICES_MIN_WIDTH_PX;
  const pickFolder = React.useCallback(async () => {
    if (!machineId) return;
    const lifetime = captureActiveServerAccountScopeLifetime();
    const capturedDraft = open.draft;
    if (!lifetime?.isCurrent() || lifetime.scope.serverId !== props.scope.serverId) return;
    const path = await openMachinePathBrowserModal({
      machineId,
      serverId: props.scope.serverId,
      title: t('projects.open.aFolder'),
      initialPath: machineHomeDir,
      selectionMode: 'directory',
    });
    if (path && lifetime.isCurrent() && draftRef.current === capturedDraft) {
      setSubjectRef.current({ kind: 'folder', path });
    }
  }, [machineId, machineHomeDir, props.scope.serverId, open.draft]);
  const pickFolderRef = React.useRef(pickFolder);
  pickFolderRef.current = pickFolder;
  const cancel = () => {
    open.cancel();
    if (props.onClose) props.onClose();
    else safeRouterBack({ router, fallbackHref: '/projects' });
  };
  const inheritedBack = useNavigationBackControl();
  const pageBack = usePageBackControl('projects.open.back', cancel);
  // What Open would send: the stored draft, or the draft with the shown default once the rows are complete.
  const effectiveDraft = draft && defaultsPending && rowsCensusComplete ? buildProjectOpenDraft(choiceBase) : draft;
  const submit = () => {
    if (effectiveDraft && effectiveDraft !== draft) open.setDraft(effectiveDraft);
    return open.submit();
  };
  const submitDisabled = !effectiveDraft || (!(open.result && 'kind' in open.result && open.result.kind === 'opened')
      && !buildProjectOpenInput(effectiveDraft, Array.isArray(checkouts) ? checkouts : [])) || open.pending
    || (open.result && 'kind' in open.result && open.result.kind === 'outcomeUnknown') === true;
  const actionsRef = React.useRef({ cancel, submit });
  actionsRef.current = { cancel, submit };
  // The dialog's footer is the card's own slot; the callbacks read through a ref, so only the
  // button states re-publish the chrome.
  const dialogChrome = React.useMemo(() => (dialog ? {
    kind: 'card' as const,
    footer: (
      <ProjectOpenFooter
        // A narrow card takes the phone composition: the note on its own line, then one full-width Open project.
        layout={twoPanes ? 'row' : 'stacked'}
        disabled={submitDisabled}
        loading={open.pending}
        onCancel={() => actionsRef.current.cancel()}
        onSubmit={() => { void actionsRef.current.submit(); }}
      />
    ),
  } : null), [dialog, open.pending, submitDisabled, twoPanes]);
  useModalCardChrome(props.setChrome, dialogChrome);

  const selectedSourceId = subject?.kind === 'source' ? subject.source.id : null;
  const sourceName = subject?.kind === 'source'
    ? catalog.rows.find((row) => row.id === subject.source.id)?.name
      ?? subject.source.repository.repository.nameWithOwner.split('/').pop()
      ?? subject.source.repository.repository.nameWithOwner
    : null;
  const openSourceSheet = () => {
    Modal.show({
      component: ProjectOpenSourceSheet,
      props: {
        scope: props.scope,
        selectedSourceId,
        folderSelected: subject?.kind === 'folder',
        folderDisabled: !machineId,
        onSelectSource: (source: ProjectSourceV1) => setSubjectRef.current({ kind: 'source', source }),
        onPickFolder: () => { void pickFolderRef.current(); },
      },
      closeOnBackdrop: true,
      chrome: {
        kind: 'card',
        title: t('projects.open.source'),
        phonePresentation: 'sheet',
        scrollHost: 'body',
        bodyScroll: 'none',
        dimensions: { maxHeightRatio: 0.85 },
      },
    });
  };

  const machineName = machine ? (machineNames.get(machine.id) ?? getMachineDisplayName(machine)) : null;
  const machineSentenceName = machine ? sentenceMachineName(machine.id) : '';
  const checkoutsHere = options.find((option) => option.use === 'existing')?.candidates.length ?? 0;
  const whereStatus: ProjectOpenWhereStatus = !machine || !machineName
    ? { kind: 'none' }
    : machinePresence.reachability === 'unreachable'
      ? { kind: 'offline' }
      : machinePresence.reachability === 'reachable'
        ? {
            kind: 'online',
            platform: formatOSPlatform(machine.metadata?.platform ?? undefined),
            checkoutsHere: checkoutsHere > 0 && sourceName
              ? t('projects.open.checkoutsHere', { count: checkoutsHere, source: sourceName })
              : null,
          }
        : { kind: 'none' };
  // Several checkouts of the Source on this Machine: the selected existing/worktree row names one and
  // changes which through the same menu pattern as Where (never a separate list on the page).
  const checkoutKey = (ref: Readonly<{ machineId: string; rootPath: string; id: string }>) => `${ref.machineId}\u0000${ref.rootPath}\u0000${ref.id}`;
  const useRows = options.map((option) => ({
    use: option.use,
    ...((option.use === 'existing' || option.use === 'worktree') && option.candidates.length > 1 ? {
      checkoutChoice: {
        items: option.candidates.map((candidate) => ({
          id: checkoutKey(candidate),
          title: formatPathRelativeToHome(candidate.rootPath, choiceBase.machineHomeDir ?? undefined),
          ...(candidate.lastOpenedAtMs != null
            ? { subtitle: t('projects.open.openedAgo', { when: formatRelativeTime(candidate.lastOpenedAtMs) }) } : {}),
        })),
        selectedId: option.from ? checkoutKey(option.from) : null,
        onSelect: (key: string) => {
          const candidate = option.candidates.find((ref) => checkoutKey(ref) === key);
          if (candidate) edit({ checkoutId: candidate.id, checkoutAddress: { serverId: candidate.serverId,
            workspaceId: candidate.id, machineId: candidate.machineId, rootPath: candidate.rootPath } });
        },
      },
    } : {}),
    ...describeProjectOpenUse({
      use: option.use,
      machineName: machineSentenceName,
      fromPath: option.from
        ? formatPathRelativeToHome(option.from.rootPath, choiceBase.machineHomeDir ?? undefined)
        : null,
      gitRef: ref ?? (subject?.kind === 'source' ? (subject.source.defaultRef ?? null) : null),
      lastOpenedAtMs: option.from?.lastOpenedAtMs ?? null,
      candidateCount: option.candidates.length,
      // A clone says where it lands: the folder set, else the one it would suggest.
      destination: (effectiveDestination.trim() || suggestProjectOpenDestination(choiceBase))
        ? formatPathRelativeToHome(effectiveDestination.trim() || suggestProjectOpenDestination(choiceBase), choiceBase.machineHomeDir ?? undefined)
        : null,
    }),
  }));

  return (
    <View
      testID="projects.open"
      style={styles.root}
      onLayout={(event: LayoutChangeEvent) => {
        const next = event.nativeEvent.layout.width;
        setWidth((current) => (current === next ? current : next));
      }}
    >
      <View style={[styles.panes, twoPanes ? styles.panesRow : null]}>
        {twoPanes ? (
          <View
            style={[
              styles.sourcePane,
              { borderRightColor: theme.colors.border.subtle },
            ]}
          >
            <ProjectOpenSourceChooser
              groups={groups}
              empty={groups.length === 0 && catalog.status === 'ready'}
              query={query}
              onChangeQuery={(next) => {
                setQuery(next);
                void catalogController.load(next);
              }}
              selectedSourceId={selectedSourceId}
              folderSelected={subject?.kind === 'folder'}
              folderDisabled={!machineId}
              onSelectSource={(source) => setSubject({ kind: 'source', source })}
              onPickFolder={() => { void pickFolder(); }}
            />
          </View>
        ) : null}
        <ItemList
          testID="projects.open.choices"
          style={styles.choicesPane}
          // A card's page list is contained and owns no inset: the dialog gives the choices the card's sheet inset.
          containerStyle={dialog ? styles.choicesInset : undefined}
        >
          {dialog ? null : (
            // A pushed page leaves through Back (lab OPENp "‹ Projects"); Cancel belongs to the dialog's footer and to
            // modal sheets, never to this page's header. Where the footer is the phone's, this Back is its cancel.
            <NavigationBackChromeProvider control={twoPanes ? inheritedBack : pageBack}>
              <PageHeader
                title={t('projects.open.title')}
                description={t('projects.open.purpose')}
                alwaysShowTitle
              />
            </NavigationBackChromeProvider>
          )}
          <ProjectOpenSubjectSection
            subject={subject}
            sourceName={sourceName}
            gitRef={ref}
            subdir={choiceBase.subdir ?? ''}
            compact={!twoPanes}
            onChooseSource={openSourceSheet}
            onChangeRef={setRef}
            onChangeSubdir={setSubdir}
            repositoryAddress={!subject && effectiveUse === 'clone' ? {
              value: repositoryAddress.resolution.kind === 'idle' ? '' : repositoryAddress.resolution.address,
              error: repositoryAddress.refusal && repositoryAddress.refusal !== 'projects.sources.loading'
                ? presentProjectSourceAddressRefusal(repositoryAddress.resolution, repositoryAddress.refusal, sentenceMachineName) : null,
              onCommit: (text) => { void repositoryAddress.resolve(text, machineId); },
            } : null}
          />
          <ProjectOpenWhereRow
            items={candidates.map((candidate) => ({
              id: candidate.id,
              title: machineNames.get(candidate.id)!,
              // A choice says its state in a word; the full sentence belongs to the chosen Where row.
              subtitle: resolveMachineReachability(props.scope, candidate, presenceNowMs) === 'unknown' ? t('common.unknown') : isMachineSelectableForFleet(props.scope, candidate, presenceNowMs)
                ? [t('status.online'), formatOSPlatform(candidate.metadata?.platform ?? undefined)].filter(Boolean).join(' · ')
                : t('status.offline'),
              icon: (
                <Icon
                  name="desktop"
                  size={ICON_SIZE.sm}
                  color={theme.colors.text.secondary}
                />
              ),
              checked: candidate.id === machineId,
            }))}
            selectedId={machineId}
            machineName={machineName}
            status={whereStatus}
            compact={!twoPanes}
            onSelect={setMachineId}
          />
          <ProjectOpenUseSection
            rows={useRows}
            selected={effectiveUse}
            destination={effectiveDestination}
            destinationPlaceholder={suggestProjectOpenDestination(choiceBase)}
            branch={branch}
            onSelect={setUse}
            onChangeDestination={setDestination}
            onChangeBranch={setBranch}
          />
          {effectiveUse === 'copy' && choiceBase.materialization?.kind === 'sync' ? <WorkspaceActivationSyncFields
            action={choiceBase.materialization.workspaceAction}
            onChange={workspaceAction => {
              // The Sync fields never offer `none`; attachment is a different Open choice.
              if (workspaceAction.kind === 'none') return;
              edit({ materialization: { kind: 'sync', targetPath: effectiveDestination, workspaceAction } });
            }}
            testIdPrefix="projects.open"
          /> : null}
          <ProjectOpenOutcome open={open} gitRef={ref}
            machineName={(id) => machineNames.get(id) ?? getMachineDisplayName(machines.find((candidate) => candidate.id === id) ?? null) ?? id}
            sentenceMachineName={sentenceMachineName}
            onChooseCandidate={candidate => {
            const checkout = workspaceAddressFromRefV1(candidate);
            if (!open.draft) return;
            open.setDraft({ ...open.draft, source: open.draft.source?.kind === 'source'
                ? open.draft.source : { kind: 'workspace', workspaceId: checkout.workspaceId },
              editing: { ...open.draft.editing, checkout } });
          }} />
        </ItemList>
      </View>
      {dialog ? null : (
        <ProjectOpenFooter
          layout={twoPanes ? 'row' : 'phone'}
          disabled={submitDisabled}
          loading={open.pending}
          onCancel={cancel}
          onSubmit={() => { void submit(); }}
        />
      )}
    </View>
  );
});

/**
 * The footer (lab `l12-mf` / `l12-pfoot`): on a computer the setup note, a quiet Cancel and the one
 * primary; on a phone one full-width Open project above the keyboard and safe area, with Back as the
 * cancel.
 */
function ProjectOpenFooter(
  props: Readonly<{
    /** `stacked`: a narrow dialog card; the phone composition without the page's sticky, inset footer. */
    layout: 'row' | 'stacked' | 'phone';
    disabled: boolean;
    loading: boolean;
    onCancel: () => void;
    onSubmit: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const note = (
    <View style={[styles.footerNoteRow, props.layout === 'stacked' ? styles.footerNoteRowStacked : null]}>
      <Icon name="info" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
      <Text numberOfLines={props.layout === 'row' ? undefined : 1}
        style={[styles.footerNote, { color: theme.colors.text.secondary }]}>
        {t('projects.open.setupDisclosure')}
      </Text>
    </View>
  );
  const submit = (
    <RoundButton
      testID="projects.open.submit"
      size={props.layout === 'row' ? 'small' : 'normal'}
      title={t('projects.open.submit')}
      disabled={props.disabled}
      loading={props.loading}
      onPress={props.onSubmit}
    />
  );
  if (props.layout === 'phone') {
    return (
      <KeyboardStickyFooter>
        <PagePinnedBar style={styles.phoneFooter}>
          {note}
          {submit}
        </PagePinnedBar>
      </KeyboardStickyFooter>
    );
  }
  if (props.layout === 'stacked') {
    // The phone composition inside the card's own footer slot: the note, then the one full-width
    // Open project. The card's close button is the cancel; the slot already sits above the keyboard.
    return (
      <View style={[styles.footerStacked, { borderTopColor: theme.colors.border.subtle }]}>
        {note}
        {submit}
      </View>
    );
  }
  return (
    <View style={[styles.footer, { borderTopColor: theme.colors.border.subtle }]}>
      {note}
      <RoundButton
        testID="projects.open.cancel"
        size="small"
        display="inverted"
        title={t('common.cancel')}
        onPress={props.onCancel}
      />
      {submit}
    </View>
  );
}

/**
 * "Source": what will be opened. On a computer the repository, its branch as a field select and the
 * folder; on a phone the Source is one row that opens the source sheet, then Branch and Folder.
 */
function ProjectOpenSubjectSection(
  props: Readonly<{
    subject: ProjectOpenSubject | null;
    sourceName: string | null;
    gitRef: string | null;
    subdir: string;
    compact: boolean;
    onChooseSource: () => void;
    onChangeRef: (ref: string | null) => void;
    onChangeSubdir: (subdir: string) => void;
    /** A clone with no repository yet: the address to read. */
    repositoryAddress: Readonly<{ value: string; error: string | null; onCommit: (text: string) => void }> | null;
  }>,
) {
  const { theme } = useUnistyles();
  const subject = props.subject;
  if (!subject && props.repositoryAddress) {
    const address = props.repositoryAddress;
    return (
      <ItemGroup title={t('projects.open.source')}>
        <FieldValueItem
          testID="projects.open.subject.address"
          title={t('projects.open.repository')}
          value={address.value}
          placeholder={t('projects.sources.addressPlaceholder')}
          fieldTestID="projects.open.subject.addressField"
          monospace
          autoCapitalize="none"
          autoFocus
          error={address.error}
          onCommit={(text) => { address.onCommit(text); return text; }}
        />
      </ItemGroup>
    );
  }
  if (!subject) {
    return props.compact ? (
      <ItemGroup title={t('projects.open.source')}>
        <Item
          testID="projects.open.subject.choose"
          title={t('projects.open.chooseSource')}
          icon={<Icon name="git-branch" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
          onPress={props.onChooseSource}
        />
      </ItemGroup>
    ) : null;
  }
  if (subject.kind === 'folder') {
    return (
      <ItemGroup title={t('projects.open.source')}>
        <Item
          testID="projects.open.subject.folder"
          title={t('projects.open.folder')}
          subtitle={subject.path}
          showChevron={props.compact}
          {...(props.compact ? { onPress: props.onChooseSource } : {})}
        />
      </ItemGroup>
    );
  }
  const source = subject.kind === 'source' ? subject.source : null;
  const repository = source?.repository ?? (subject.kind === 'repository' ? subject.selector : null);
  const defaultRef = source?.defaultRef ?? null;
  return (
    <ItemGroup title={t('projects.open.source')}>
      {source && props.compact ? (
        <Item
          testID="projects.open.subject.repository"
          title={props.sourceName ?? formatProjectSourceAddress(source.repository)}
          subtitle={formatProjectSourceAddress(source.repository)}
          icon={<Icon name="git-branch" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
          onPress={props.onChooseSource}
        />
      ) : repository ? (
        <Item
          testID="projects.open.subject.repository"
          title={t('projects.open.repository')}
          detail={formatProjectSourceAddress(repository)}
          // An address is an identifier: the mono role, as on the Source's own header.
          detailStyle={styles.address}
          showChevron={false}
        />
      ) : (
        <Item
          testID="projects.open.subject.checkout"
          title={t('projects.open.repository')}
          detail={subject.kind === 'workspace' ? subject.workspace.rootPath : ''}
          detailStyle={styles.address}
          showChevron={false}
        />
      )}
      <ProjectRefSelect
        testID="projects.open.subject.ref"
        title={t('projects.open.branch')}
        value={props.gitRef}
        defaultLabel={defaultRef
          ? t('projects.open.defaultRef', { ref: defaultRef })
          : t('projects.sources.repositoryDefault')}
        {...(defaultRef ? { placeholder: defaultRef } : {})}
        compact={props.compact}
        onChange={props.onChangeRef}
      />
      {repository ? (
        <FieldValueItem
          testID="projects.open.subject.folder"
          title={t('projects.open.folder')}
          value={props.subdir}
          placeholder={source?.subdir ?? t('projects.sources.wholeRepository')}
          fieldTestID="projects.open.subject.subdir"
          monospace
          autoCapitalize="none"
          onCommit={props.onChangeSubdir}
        />
      ) : null}
    </ItemGroup>
  );
}

/** One "Use" choice in the person's terms: what it is, and the exact path, ref or account it uses. */
function describeProjectOpenUse(
  input: Readonly<{
    use: ProjectOpenUse;
    machineName: string;
    fromPath: string | null;
    gitRef: string | null;
    /** When the existing checkout was last opened here, if known. */
    lastOpenedAtMs: number | null;
    /** How many checkouts of the Source are here; several and none chosen means the person picks one. */
    candidateCount: number;
    /** The clone's destination, home-relative; null while none is set. */
    destination: string | null;
  }>,
): Readonly<{ title: string; subtitle: string | undefined }> {
  switch (input.use) {
    case 'existing':
      return {
        title: t('projects.open.existing', { machine: input.machineName }),
        // "~/src/happier · v0.3 · opened 2 days ago": which checkout, its branch, and when it was last used.
        subtitle: input.fromPath
          ? [
              input.gitRef ? t('projects.open.existingDetail', { path: input.fromPath, ref: input.gitRef }) : input.fromPath,
              input.lastOpenedAtMs != null ? t('projects.open.openedAgo', { when: formatRelativeTime(input.lastOpenedAtMs) }) : null,
            ].filter(Boolean).join(' · ')
          : input.candidateCount > 1 ? t('projects.open.chooseCheckout', { count: input.candidateCount }) : undefined,
      };
    case 'worktree':
      return {
        title: t('projects.open.worktree'),
        subtitle: input.fromPath ? t('projects.open.worktreeDetail', { path: input.fromPath })
          : input.candidateCount > 1 ? t('projects.open.chooseCheckout', { count: input.candidateCount }) : undefined,
      };
    case 'clone':
      return {
        title: t('projects.open.clone'),
        subtitle: input.destination ? t('projects.open.cloneDetail', { path: input.destination }) : undefined,
      };
    case 'copy':
      return { title: t('projects.open.copy'), subtitle: t('projects.open.copyDetail') };
  }
}

/** What the last confirmation came to, while it stays on this screen: its step, or the outcome and next action. */
function ProjectOpenOutcome(props: Readonly<{ open: ReturnType<typeof useProjectOpen>; gitRef: string | null;
    machineName(machineId: string): string;
    sentenceMachineName(machineId: string): string;
    onChooseCandidate(candidate: Parameters<typeof workspaceAddressFromRefV1>[0]): void }>) {
    const result = props.open.result;
    if (props.open.pending) return <AttentionBanner testID="projects.open.pending" tone="neutral" title={t('projects.open.resolving')} />;
    if (!result) {
        // A retired attempt is history: it says what happened and never offers to navigate from it.
        const retired = props.open.retiredAttempt;
        return retired ? <AttentionBanner testID="projects.open.retired" tone="neutral" title={t('projects.open.retired')}
            details={['retired_attempt', retired.input.serverId, retired.input.machineId,
                'kind' in retired.result ? retired.result.kind : retired.result.errorCode]} /> : null;
    }
    if ('ok' in result && result.ok === false) {
        return <AttentionBanner testID="projects.open.failed" title={t('projects.open.unsupported')} details={[result.errorCode]} />;
    }
    if (!('kind' in result)) return null;
    switch (result.kind) {
        case 'opened':
            // Accepted but not focused here: the only next step is to go to it ("prepared" is readiness, not setup success).
            return props.open.focusUnavailable ? <AttentionBanner testID="projects.open.acceptedUnfocused" tone="neutral"
              title={t('projects.open.opened', { machine: props.sentenceMachineName(result.workspace.machineId) })}
              description={result.directory} details={[result.setup]}
              action={{ label: t('projects.open.focus'), onPress: () => props.open.submit() }} /> : null;
        case 'ambiguous':
            return <ItemGroup title={t('projects.open.ambiguous')} description={t('projects.open.chooseExact')}>
                {result.candidates.map(candidate => <Item
                    key={`${candidate.serverId}:${candidate.machineId}:${candidate.id}:${candidate.rootPath}`}
                    testID={`projects.open.candidate.${candidate.machineId}:${candidate.id}`}
                    title={candidate.label ?? candidate.rootPath} subtitle={`${props.machineName(candidate.machineId)} · ${candidate.rootPath}`}
                    onPress={() => props.onChooseCandidate(candidate)} showChevron={false} />)}
            </ItemGroup>;
        case 'outcomeUnknown':
            return <AttentionBanner testID="projects.open.unknown" title={t('projects.open.checkingOutcome')}
                description={props.open.canCheck ? undefined : t('projects.open.inspectUnknown')}
                details={props.open.uncertainInput ? [props.open.uncertainInput.serverId,
                    props.machineName(props.open.uncertainInput.machineId),
                    ...(props.open.uncertainInput.materialization.kind === 'clone'
                        ? [props.open.uncertainInput.materialization.destinationParentPath, props.open.uncertainInput.materialization.destinationDirectoryName]
                        : props.open.uncertainInput.materialization.kind === 'sync' ? [props.open.uncertainInput.materialization.targetPath]
                        : props.open.uncertainInput.source.kind === 'folder' ? [props.open.uncertainInput.source.path] : [])] : undefined}
                action={props.open.canCheck ? { label: t('projects.open.check'), onPress: () => { void props.open.check(); },
                    disabled: props.open.checking, loading: props.open.checking } : undefined} />;
        case 'refused':
            if (result.code === 'REMOTE_RATE_LIMITED') return <AttentionBanner testID="projects.open.refused" tone="danger"
                title={result.retryNotBeforeMs !== undefined
                    ? t('projects.open.githubRateLimitedUntil', { time: formatResetAtTime(result.retryNotBeforeMs) })
                    : t('projects.open.githubRateLimited')}
                description={result.remediation?.action === 'connect_github' ? t('projects.open.githubConnectHint') : undefined}
                details={[result.code]} />;
            return <AttentionBanner testID="projects.open.refused" tone="danger" {...projectOpenRefusalPresentation(result.code, props.gitRef)} details={[result.code]} />;
    }
}

const styles = StyleSheet.create(() => ({
  root: { flex: 1, minHeight: 0 },
  panes: { flex: 1, minHeight: 0 },
  panesRow: { flexDirection: 'row' },
  sourcePane: {
    width: SOURCE_LIST_WIDTH_PX,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  choicesPane: { flex: 1, minWidth: 0 },
  choicesInset: { paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // Inside the card's footer slot, which already carries the card's edge inset: the note and the
  // button line up with the sheets above.
  footerStacked: {
    gap: 10,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  phoneFooter: { gap: 10 },
  footerNoteRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  footerNoteRowStacked: { flex: 0 },
  footerNote: { ...Typography.variant('meta'), flexShrink: 1 },
  address: { ...Typography.mono() },
}));

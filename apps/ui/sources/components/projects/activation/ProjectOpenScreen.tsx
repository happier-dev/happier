import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { SessionDraftAddressV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { randomUUID } from '@/platform/randomUUID';
import { useOpenProject } from '../useOpenProject';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { ensureSessionDraftRepositoryHydrated, flushProjectOpenDraftLocally } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import {
  useLocalSearchParams,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
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
  useWorkspaceRefs,
} from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { formatResetAtTime } from '@/utils/time/formatResetAtTime';
import {
  getMachineDisplayName,
  isMachineOnline,
} from '@/utils/sessions/machineUtils';
import { resolveMachineActionCandidates } from '@/utils/sessions/resolveMachineActionCandidates';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';

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
  suggestProjectOpenDestination,
  type ProjectOpenSubject,
  type ProjectOpenUse,
} from './projectOpenChoices';
import { readProjectOpenRouteDraft } from './projectOpenRoute';
import { ProjectOpenSourceChooser, ProjectOpenSourceSheet, useProjectSourceTeamName } from './ProjectOpenSourceChooser';
import { useProjectOpen } from './useProjectOpen';

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
      await flushProjectOpenDraftLocally({ scope, draftId });
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
  const checkouts = useWorkspaceRefs();
  const openProject = useOpenProject();
  const { state: catalog, controller: catalogController } = useProjectSources(
    props.scope,
  );
  const teamName = useProjectSourceTeamName(props.scope.serverId);

  const candidates = React.useMemo(
    () => resolveMachineActionCandidates(machines, { onlineOnly: false }),
    [machines],
  );
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
  const choiceBase = projectOpenChoiceStateFromDraft(open.draft ?? { serverId: props.scope.serverId },
    Array.isArray(checkouts) ? checkouts : [], machineHomeDir);
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
    // A choice that leaves exactly one way to open takes it, and a clone or copy starts at the
    // suggested folder (or follows it to a new machine). Both answer the person's own choice; typing
    // a folder or a branch never re-suggests over it.
    if (patch.destination === undefined && patch.branch === undefined) {
      const reachable = resolveProjectOpenUseOptions(next);
      if (reachable.length === 1 && next.use !== reachable[0]!.use) next = { ...next, use: reachable[0]!.use };
      const suggested = suggestProjectOpenDestination(choiceBase);
      if ((next.use === 'clone' || next.use === 'copy')
        && (!next.destination.trim() || next.destination === suggested)) {
        next = { ...next, destination: suggestProjectOpenDestination(next) };
      }
    }
    open.setDraft(buildProjectOpenDraft(next));
  };
  const setSubject = (next: ProjectOpenSubject) => edit({ subject: next, checkoutId: null, checkoutAddress: null });
  const setMachineId = (next: string) => edit({ machineId: next });
  const setRef = (next: string | null) => edit({ ref: next });
  const setUse = (next: ProjectOpenUse) => edit({ use: next });
  const setBranch = (next: string) => edit({ branch: next });
  const setDestination = (next: string) => edit({ destination: next });
  const setSubjectRef = React.useRef(setSubject);
  setSubjectRef.current = setSubject;

  function opened(result: Extract<OpenProjectResultV1, { kind: 'opened' }>) {
      const machineName =
        getMachineDisplayName(
          machines.find((candidate) => candidate.id === result.workspace.machineId) ?? null,
        ) ?? result.workspace.machineId;
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
    else router.back();
  };
  const submitDisabled = !draft || (!(open.result && 'kind' in open.result && open.result.kind === 'opened')
      && !buildProjectOpenInput(draft, Array.isArray(checkouts) ? checkouts : [])) || open.pending
    || (open.result && 'kind' in open.result && open.result.kind === 'outcomeUnknown') === true;
  const actionsRef = React.useRef({ cancel, submit: open.submit });
  actionsRef.current = { cancel, submit: open.submit };
  // The dialog's footer is the card's own slot; the callbacks read through a ref, so only the
  // button states re-publish the chrome.
  const dialogChrome = React.useMemo(() => (dialog ? {
    kind: 'card' as const,
    footer: (
      <ProjectOpenFooter
        layout="row"
        disabled={submitDisabled}
        loading={open.pending}
        onCancel={() => actionsRef.current.cancel()}
        onSubmit={() => { void actionsRef.current.submit(); }}
      />
    ),
  } : null), [dialog, open.pending, submitDisabled]);
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

  const machineName = machine ? (getMachineDisplayName(machine) ?? machine.id) : null;
  const checkoutsHere = options.find((option) => option.use === 'existing')?.candidates.length ?? 0;
  const whereStatus: ProjectOpenWhereStatus = !machine || !machineName
    ? { kind: 'none' }
    : machinePresence.reachability === 'unreachable'
      ? { kind: 'offline', machineName }
      : machinePresence.reachability === 'reachable'
        ? {
            kind: 'online',
            platform: formatOSPlatform(machine.metadata?.platform ?? undefined),
            checkoutsHere: checkoutsHere > 0 && sourceName
              ? t('projects.open.checkoutsHere', { count: checkoutsHere, source: sourceName })
              : null,
          }
        : { kind: 'none' };
  const useRows = options.map((option) => ({
    use: option.use,
    ...describeProjectOpenUse({
      use: option.use,
      machineName: machineName ?? '',
      fromPath: option.from
        ? formatPathRelativeToHome(option.from.rootPath, choiceBase.machineHomeDir ?? undefined)
        : null,
      gitRef: ref ?? (subject?.kind === 'source' ? (subject.source.defaultRef ?? null) : null),
      destination: effectiveDestination.trim()
        ? formatPathRelativeToHome(effectiveDestination.trim(), choiceBase.machineHomeDir ?? undefined)
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
        <ItemList testID="projects.open.choices" style={styles.choicesPane}>
          {dialog ? null : (
            <PageHeader
              title={t('projects.open.title')}
              description={t('projects.open.purpose')}
              alwaysShowTitle
              cancelAction={!twoPanes ? { title: t('common.cancel'), onPress: cancel, testID: 'projects.open.cancel' } : undefined}
            />
          )}
          <ProjectOpenSubjectSection
            subject={subject}
            sourceName={sourceName}
            gitRef={ref}
            compact={!twoPanes}
            onChooseSource={openSourceSheet}
            onChangeRef={setRef}
          />
          {options.find(option => option.use === effectiveUse)?.candidates.length ? (
            <ItemGroup title={t('projects.open.chooseExact')}>
              {options.find(option => option.use === effectiveUse)?.candidates.map(candidate => (
                <Item key={`${candidate.serverId}:${candidate.machineId}:${candidate.id}:${candidate.rootPath}`}
                  title={candidate.label ?? candidate.rootPath} subtitle={candidate.rootPath}
                  selected={choiceBase.checkoutAddress?.workspaceId === candidate.id
                    && choiceBase.checkoutAddress.machineId === candidate.machineId
                    && choiceBase.checkoutAddress.rootPath === candidate.rootPath}
                  onPress={() => edit({ checkoutId: candidate.id, checkoutAddress: { serverId: candidate.serverId,
                    workspaceId: candidate.id, machineId: candidate.machineId, rootPath: candidate.rootPath } })}
                  showChevron={false} />
              ))}
            </ItemGroup>
          ) : null}
          <ProjectOpenWhereRow
            items={candidates.map((candidate) => ({
              id: candidate.id,
              title: getMachineDisplayName(candidate) ?? candidate.id,
              subtitle: isMachineOnline(candidate, presenceNowMs)
                ? undefined
                : t('projects.open.offline', {
                    machine: getMachineDisplayName(candidate) ?? candidate.id,
                  }),
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
          <ProjectOpenOutcome open={open} gitRef={ref}
            machineName={(id) => getMachineDisplayName(machines.find((candidate) => candidate.id === id) ?? null) ?? id}
            onFocus={(workspace) => openProject(workspace.workspaceId, { serverId: workspace.serverId })}
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
          onSubmit={() => { void open.submit(); }}
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
    layout: 'row' | 'phone';
    disabled: boolean;
    loading: boolean;
    onCancel: () => void;
    onSubmit: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const insets = useChromeSafeAreaInsets();
  const note = (
    <View style={styles.footerNoteRow}>
      <Icon name="info" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
      <Text numberOfLines={props.layout === 'phone' ? 1 : undefined}
        style={[styles.footerNote, { color: theme.colors.text.secondary }]}>
        {t('projects.open.setupDisclosure')}
      </Text>
    </View>
  );
  const submit = (
    <RoundButton
      testID="projects.open.submit"
      size={props.layout === 'phone' ? 'normal' : 'small'}
      title={t('projects.open.submit')}
      disabled={props.disabled}
      loading={props.loading}
      onPress={props.onSubmit}
    />
  );
  if (props.layout === 'phone') {
    return (
      <KeyboardStickyFooter
        style={[styles.phoneFooter, { borderTopColor: theme.colors.border.subtle, paddingBottom: Math.max(insets.bottom, 12) }]}
      >
        {note}
        {submit}
      </KeyboardStickyFooter>
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
    compact: boolean;
    onChooseSource: () => void;
    onChangeRef: (ref: string | null) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const subject = props.subject;
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
      ) : source ? (
        <Item
          testID="projects.open.subject.repository"
          title={t('projects.open.repository')}
          detail={formatProjectSourceAddress(source.repository)}
          showChevron={false}
        />
      ) : (
        <Item
          testID="projects.open.subject.checkout"
          title={t('projects.open.repository')}
          detail={subject.kind === 'workspace' ? subject.workspace.rootPath : ''}
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
        onChange={props.onChangeRef}
      />
      {source ? (
        <Item
          testID="projects.open.subject.folder"
          title={t('projects.open.folder')}
          detail={source.subdir ?? t('projects.sources.wholeRepository')}
          showChevron={false}
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
    /** The clone's destination, home-relative; null while none is set. */
    destination: string | null;
  }>,
): Readonly<{ title: string; subtitle: string | undefined }> {
  switch (input.use) {
    case 'existing':
      return {
        title: t('projects.open.existing', { machine: input.machineName }),
        subtitle: input.fromPath
          ? input.gitRef
            ? t('projects.open.existingDetail', { path: input.fromPath, ref: input.gitRef })
            : input.fromPath
          : undefined,
      };
    case 'worktree':
      return {
        title: t('projects.open.worktree'),
        subtitle: input.fromPath ? t('projects.open.worktreeDetail', { path: input.fromPath }) : undefined,
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
    onFocus(workspace: Extract<OpenProjectResultV1, { kind: 'opened' }>['workspace']): void;
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
              title={t('projects.open.opened', { machine: props.machineName(result.workspace.machineId) })}
              description={result.directory} details={[result.setup]}
              action={{ label: t('projects.open.focus'), onPress: () => props.onFocus(result.workspace) }} /> : null;
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
            return <AttentionBanner testID="projects.open.refused" tone="danger" title={refusalTitle(result.code, props.gitRef)} details={[result.code]} />;
    }
}

/** The refusal in the person's terms; the exact code stays behind Details. */
function refusalTitle(code: string, gitRef: string | null): string {
    if (code.includes('offline') || code.includes('unreachable')) return t('projects.open.accessLost');
    if (gitRef && code.includes('ref')) return t('projects.open.refMissing', { ref: gitRef });
    if (code.includes('folder') || code.includes('path')) return t('projects.open.invalidFolder');
    // Source admission (A5b): a changed Source asks for review; revoked or missing says it is gone. The draft stays.
    if (code.includes('source') && code.includes('changed')) return t('projects.open.sourceChanged');
    if (code.includes('source')) return t('projects.open.sourceUnavailable');
    return t('projects.open.unsupported');
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
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  phoneFooter: {
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerNoteRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  footerNote: { ...Typography.default(), flexShrink: 1 },
}));

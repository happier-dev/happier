import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { PluginSurfaceProjectionDemand } from '@/components/plugins/surfaces/PluginSurfaceProjectionDemand';
import { REGISTRY_SOURCE_PROJECTION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { SelectionTiles, type SelectionTile } from '@/components/ui/forms/SelectionTiles';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { NavigationBackChromeProvider } from '@/components/ui/layout/NavigationBackChrome';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { usePageBackControl } from '@/components/ui/layout/usePageBackControl';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Text } from '@/components/ui/text/Text';
import { WizardStepDots } from '@/components/onboarding/ui/WizardStepDots';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import { randomUUID } from '@/platform/randomUUID';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveMachineFacts } from '@/sync/store/hooks';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { resolveMachineActionCandidates } from '@/utils/sessions/resolveMachineActionCandidates';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { openSessionAuthoringAction } from '@/sync/ops/actions/sessionAuthoringActions';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { useDeviceType } from '@/utils/platform/responsive';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

import {
  buildStarterCreateInput,
  createStarterIntentKeys,
  deriveRepositoryName,
  readStarterCreateOutcome,
  type StarterCreateOutcome,
  type StarterCreateInput,
} from './newAppDraft';
import { projectCheckoutParentPath } from '../activation/projectOpenChoices';
import type { ProjectSourceRepositorySelectorV1, ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { StoreItemMark } from '@/components/store/catalog/StoreItemMark';
import type { DeploymentNewDefinitionKind } from '@/components/projects/deployments/deploymentNavigation';
import type { DeploymentDraftFrame } from '@/components/projects/deployments/DeploymentEnvironmentDraft';
import { NewAppCodeSources } from './NewAppCodeSources';
import { NewAppDeploySteps, NewAppDeploySummary, type NewAppDeploySource } from './NewAppDeploySteps';
import { NewAppAutoStep } from './auto/NewAppAutoStep';
import { NewAppAutoAdjust } from './auto/NewAppAutoAdjust';
import type { TransientQuestionAnswerState } from '@/components/appShell/plugins/TransientQuestionForm';
import { useNewAppAutoSuggestions, type NewAppAutoChosen } from './auto/useNewAppAutoSuggestions';
import { DEFAULT_PROJECT_REPOSITORY_PROVIDER_KIND_V1 } from '@happier-dev/protocol/projects/starters/createV1';
import { applyDeploySuggestion } from './applyDeploySuggestion';
import type { NewAppSuggestionContext } from './newAppPresentation';
import { useNewAppForges, type ForgeOwnerFact } from './useNewAppForges';
import { isRepositoryAddressCandidate } from '@/components/projects/sources/projectSourceAddress';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { QualifiedMachineV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import type { MachineCreationContinuationDraft } from '@/components/machines/add/MachineCreationContinuation';

const NewAppMachineSetup = React.lazy(() => import('./NewAppMachineSetup').then(module => ({ default: module.NewAppMachineSetup })));

/** A starter's own steps; the other ways continue through `deploy`: the Environment draft's Where → Configure → Review. */
type Step = 'start' | 'describe' | 'create' | 'deploy' | 'auto';
const STEPS: readonly Step[] = ['start', 'describe', 'create'];
/** Source, then the draft's three steps (journey-deploy D3). */
const DEPLOY_STEPS: readonly DeploymentDraftFrame['step'][] = ['where', 'configure', 'review'];
/** Already built (a stored definition the Project draft picks a Project for) or a catalog app's listing. */
type Door = `built:${DeploymentNewDefinitionKind}` | `catalog:${string}` | 'describe';
/** The lab's From the catalog row: three apps, the rest one press away in the Store. */
const CATALOG_TILES = 3;
/** A catalog tile says what the app is in its listing's own lead clause (lab: a short line); the listing has the rest. */
const leadSentence = (text: string) => {
  const clause = /^.+?(?:[.!?](?=\s|$)|(?=[:;]\s)|(?=\s[—–-]\s))/.exec(text.trim())?.[0] ?? text.trim();
  return clause.replace(/[.!?]$/, '');
};
const catalogDoor = (item: RegistryCatalogItemSummary): Door => `catalog:${JSON.stringify([item.sourceId, item.itemId])}`;

/** The Action each control uses (lab s1 NOTES "actions"). */
const CREATE_ACTION = 'projects.starters.create' as const;

type CreateState =
  | Readonly<{ kind: 'running' }>
  | StarterCreateOutcome
  /** The Project exists; only opening its first Session did not (Plan 60 §3.3 "Project ready"). */
  | Readonly<{
      kind: 'projectReady';
      created: Extract<StarterCreateOutcome, { kind: 'created' }>;
    }>;

export type NewAppScreenProps = Partial<
  Pick<CustomModalInjectedProps, 'onClose' | 'setChrome'>
> &
  Readonly<{
    starterId?: string | null;
    /** The ways to bring code you already have; offered when the entry that opened New app has them. */
    onClone?: (() => void) | null;
    /** Deploy an app here (a Machine's Services): that Machine stays chosen through every source that places work. */
    machine?: QualifiedMachineV1 | null;
    /** A Project's Deploy an app: that Project's code starts chosen as Your code. */
    projectSourceId?: string | null;
    /** Review the build preview named by a Deploy to Production entry point. */
    previewEnvironmentId?: string | null;
    /** A checked Session suggestion to open with its description and first card already selected. */
    suggestion?: NewAppSuggestionContext | null;
    /** An empty state's "Describe your app": the dialog opens on the describe step (journey-deploy S1). */
    startOn?: 'describe' | null;
  }>;

function readMachineHomeDir(
  machine: Readonly<{ metadata?: unknown }> | null | undefined,
): string | null {
  const homeDir = (
    machine?.metadata as { homeDir?: unknown } | null | undefined
  )?.homeDir;
  return typeof homeDir === 'string' && homeDir ? homeDir : null;
}

/**
 * New app from a starter (Plan 60 §3.2/§5, lab servers-deploy s1): pick a starter, describe the app,
 * review what will be created, then `projects.starters.create` makes the repository, Source and
 * Project, and the description opens as the first message of a new Session in it. A dialog on a
 * computer, a pushed page on a phone (the same steps, recomposed).
 */
export const NewAppScreen = React.memo(function NewAppScreen(
  props: NewAppScreenProps,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const phone = useDeviceType() === 'phone';
  // The page's sections stand on PageFrame's reading column; the pinned bar's contents take the same one.
  const pageMaxWidth = useLayoutMaxWidth('reading');
  const dialog = props.setChrome !== undefined;
  const scope = useActiveServerAccountScope();
  const knownMachines = useActiveMachineFacts();
  const presenceNowMs = useMachinePresenceNowMs(knownMachines);
  const reachabilityRevision = useMachineReachabilityRevision();
  // Only a Machine that is online now can build the app (a Home can hold hundreds of offline ones).
  const machines = React.useMemo(
    () => resolveMachineActionCandidates(scope, knownMachines, { nowMs: presenceNowMs }),
    [knownMachines, presenceNowMs, reachabilityRevision, scope],
  );
  const thisComputerMachineId = useThisComputerMachineId();
  // The step's one search (lab f1src): Your code narrows its repositories, starters and the catalog ask their
  // registry read with the same query (the Store's search owner).
  const [query, setQuery] = React.useState('');
  // A pasted repository link is read by Your code, not searched for: starters and the catalog stay as they were.
  const search = isRepositoryAddressCandidate(query) ? '' : query.trim();
  const starterCatalog = useRegistryItems(search ? { kind: 'starter', query: search } : { kind: 'starter' }, true);
  // Only app starters: the starter owner marks one by its app deploy shape (`starterDeploy`); a workspace template
  // such as Coder's declares none and is not a way to deploy an app.
  const starters = React.useMemo(() => starterCatalog.items.filter((item) => item.starterDeploy !== undefined),
    [starterCatalog.items]);
  const startersSettledEmpty = !search && starterCatalog.hasValue && !starterCatalog.loading && !starterCatalog.error
    && starterCatalog.sourceFailures.length === 0 && starters.length === 0;
  // Starters are package content an online Machine reads: a source that says so, or a settled empty list while no
  // Machine is online (nothing supplies the package yet, AUTO-LIVE F2), is that one cause and gets its next step.
  const startersNeedMachine = starters.length === 0 && (starterCatalog.sourceFailures.some((failure) => failure.status.state === 'needs_machine')
    || (startersSettledEmpty && machines.length === 0));

  const [step, setStep] = React.useState<Step>(props.suggestion || props.startOn === 'describe' ? 'auto' : 'start');
  // Describe your app (journey-deploy S1/S2/S!): the suggestion owner's last report, and the setup the person chose.
  const auto = useNewAppAutoSuggestions({ serverId: scope?.serverId ?? null, active: step === 'auto',
    initial: props.suggestion ? { description: props.suggestion.description, chosen: props.suggestion } : null });
  const [appliedSuggestion, setAppliedSuggestion] = React.useState<NewAppAutoChosen | null>(props.suggestion ?? null);
  // The open questions round's answers (journey-deploy F2): the step owns them, the footer sends them.
  const [questionAnswers, setQuestionAnswers] = React.useState<TransientQuestionAnswerState | null>(null);
  // Adjust (journey-deploy autoAdjust) is a view of the cards: it holds only while a chosen setup is shown.
  const [adjusting, setAdjusting] = React.useState(false);
  const [adjustNote, setAdjustNote] = React.useState('');
  const [starterId, setStarterId] = React.useState<string | null>(
    props.starterId ?? (starters.length === 1 && !props.projectSourceId ? starters[0]!.itemId : null),
  );
  // Deploy an app → Your code: a repository Project, chosen instead of a starter (lab f1src). One choice at a time.
  const [codeSourceId, setCodeSourceId] = React.useState<string | null>(props.projectSourceId ?? null);
  // Already built and From the catalog (lab f1src): a way that continues outside this dialog, chosen like the others.
  const [door, setDoor] = React.useState<Door | null>(null);
  // Your code → a pasted link to a repository that is not a Project here yet (owner ruling 20:50Z).
  const [pastedRepository, setPastedRepository] = React.useState<Readonly<{ selector: ProjectSourceRepositorySelectorV1;
    save: () => Promise<ProjectSourceV1 | undefined> }> | null>(null);
  // Saving the pasted repository as this Home's Source, on Continue; the step stays until it is kept.
  const [savingSource, setSavingSource] = React.useState(false);
  // What the deploy steps deploy, once the source step is answered; the draft frames each of its steps here.
  const [deploySource, setDeploySource] = React.useState<NewAppDeploySource | null>(null);
  const [deployFrame, setDeployFrame] = React.useState<DeploymentDraftFrame | null>(null);
  const leaveDeploy = React.useCallback(() => {
    setStep('start');
    setDeployFrame(null);
  }, []);
  const deploySteps = React.useMemo(() => ({ onFrame: setDeployFrame, onExit: leaveDeploy }), [leaveDeploy]);
  const startDeploy = React.useCallback((next: NewAppDeploySource) => {
    setDeploySource(next);
    setDeployFrame(null);
    setStep('deploy');
  }, []);
  const chooseCode = React.useCallback((next: string | null) => {
    setCodeSourceId(next);
    if (next) {
      setStarterId(null);
      setDoor(null);
      setPastedRepository(null);
    }
  }, []);
  // The chosen starter stays chosen while a search hides its tile.
  const [pickedStarter, setPickedStarter] = React.useState<RegistryCatalogItemSummary | null>(null);
  const chooseStarter = React.useCallback((next: string | null) => {
    setStarterId(next);
    setPickedStarter(next ? starters.find((candidate) => candidate.itemId === next) ?? null : null);
    if (next) {
      setCodeSourceId(null);
      setDoor(null);
      setPastedRepository(null);
    }
  }, [starters]);
  const chooseDoor = React.useCallback((next: Door | null) => {
    setDoor(next);
    if (next) {
      setStarterId(null);
      setCodeSourceId(null);
      setPastedRepository(null);
    }
  }, []);
  const choosePastedRepository = React.useCallback((selector: ProjectSourceRepositorySelectorV1,
    save: () => Promise<ProjectSourceV1 | undefined>) => {
    setPastedRepository({ selector, save });
    setStarterId(null);
    setCodeSourceId(null);
    setDoor(null);
  }, []);
  // The catalog's first apps, read only while the person is choosing a way in.
  const appCatalog = useRegistryItems(search ? { kind: 'app', query: search } : { kind: 'app' }, step === 'start');
  const catalogApps = React.useMemo(() => appCatalog.items.slice(0, CATALOG_TILES), [appCatalog.items]);
  const builtTiles = React.useMemo((): Array<SelectionTile<Door>> => [
    { id: 'built:image', testID: 'newApp.built.image', icon: 'image',
      title: t('newApp.builtImage'), subtitle: t('newApp.builtImageSubtitle') },
    { id: 'built:compose', testID: 'newApp.built.compose', icon: 'file-text',
      title: t('newApp.builtCompose'), subtitle: t('newApp.builtComposeSubtitle') },
  ], []);
  const catalogTiles = React.useMemo((): Array<SelectionTile<Door>> => catalogApps.map((item) => ({
    id: catalogDoor(item),
    testID: `newApp.catalog.${item.itemId}`,
    title: item.title,
    ...(item.description ? { subtitle: leadSentence(item.description) } : {}),
    mark: <StoreItemMark facts={{ kind: item.kind, title: item.title, brand: item.brandMark }} size={ICON_SIZE.md} />,
  })), [catalogApps]);
  const [description, setDescription] = React.useState('');
  const [name, setName] = React.useState('');
  const [machineId, setMachineId] = React.useState<string | null>(props.machine?.machineId ?? null);
  const [addingMachine, setAddingMachine] = React.useState(false);
  const [machineHomeMismatch, setMachineHomeMismatch] = React.useState(false);
  const [machineCreationDraft, setMachineCreationDraft] = React.useState<MachineCreationContinuationDraft | null>(null);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [create, setCreate] = React.useState<CreateState | null>(null);
  // One create intent per reviewed draft: a retry of the same review reuses it, so nothing is created twice.
  const [intentKeyFor] = React.useState(() => createStarterIntentKeys(randomUUID));
  const submittedInput = React.useRef<StarterCreateInput | null>(null);

  const starter =
    starters.find((candidate) => candidate.itemId === starterId)
    ?? (pickedStarter?.itemId === starterId ? pickedStarter : null);
  const effectiveMachineId =
    machineId ??
    (machines.some((candidate) => candidate.id === thisComputerMachineId)
      ? thisComputerMachineId
      : (machines[0]?.id ?? null));
  const machine =
    machines.find((candidate) => candidate.id === effectiveMachineId) ?? null;
  const homeDir = readMachineHomeDir(machine);

  // Code lives on (journey-deploy F5): the forge owner offers forges and says where the repository would go on each.
  const forge = useNewAppForges({ serverId: scope?.serverId ?? null, machineId: effectiveMachineId, homeDir,
    active: step === 'describe', suggestion: appliedSuggestion });
  const owner = forge.owner;
  // A suggested scratch setup creates an empty repository; a starter picked by hand clears it.
  const scratch = starterId === null && appliedSuggestion?.recommendation.source.kind === 'scratch';

  const repositoryName = deriveRepositoryName(name);
  const input = scope
    ? buildStarterCreateInput(
        { starterId, scratch, description, name, machineId: effectiveMachineId },
        {
          serverId: scope.serverId,
          homeDir,
          owner: owner.kind === 'ready' ? owner.owner : null,
          providerKind: forge.chosen,
          // The exact deployment the row described (two Azure orgs, cloud and self-managed GitLab): U5 9f807c9bfa6.
          provider: owner.kind === 'ready' ? { id: owner.target.provider.id, baseUrl: owner.target.provider.baseUrl } : null,
          requestKey: intentKeyFor({
            starterId,
            scratch,
            description,
            name,
            machineId: effectiveMachineId,
            owner: owner.kind === 'ready' ? owner.owner : null,
            providerKind: forge.chosen,
            providerId: owner.kind === 'ready' ? owner.target.provider.id : null,
          }),
        },
      )
    : null;

  // Leaving without going anywhere: the modal host closes; as its own page, New app goes back.
  const close = React.useCallback(() => {
    if (props.onClose) props.onClose();
    else safeRouterBack({ router, fallbackHref: '/projects' });
  }, [props.onClose, router]);
  // Before a way out navigates forward, only a modal host steps aside. Going back as a page would race that navigation.
  const stepAside = React.useCallback(() => {
    props.onClose?.();
  }, [props.onClose]);

  // Already built and a catalog app continue in this flow's deploy steps, whose draft asks for the Project (journey-deploy
  // imgCfg, catWhere); a catalog app picked here takes the same source as a suggested one. Browse steps aside first.
  const continueThroughDoor = (chosen: Door) => {
    if (!scope) return;
    if (chosen === 'describe') {
      setStep('auto');
      return;
    }
    if (chosen === 'built:image' || chosen === 'built:compose') {
      startDeploy({ kind: 'definition', definitionKind: chosen === 'built:image' ? 'image' : 'compose' });
      return;
    }
    const item = catalogApps.find((candidate) => catalogDoor(candidate) === chosen);
    if (!item) return;
    startDeploy({ kind: 'catalogApp', app: { sourceId: item.sourceId, itemId: item.itemId } });
  };
  const browseCatalog = () => {
    stepAside();
    router.push(buildPluginsHomeRoute('app', { view: 'kind', kind: 'app', machine: props.machine ?? null }) as never);
  };
  // Every starter, where the catalog lists them: the Store's starter kind (journey-deploy jdF-src "All starters").
  const browseStarters = () => {
    stepAside();
    router.push(buildPluginsHomeRoute('app', { view: 'kind', kind: 'starter', machine: props.machine ?? null }) as never);
  };

  const connectGithub = React.useCallback(() => {
    void (async () => {
      const [{ presentConnectSheet }, { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID }] = await Promise.all([
        import('@/components/settings/connectedServices/setup/ConnectedServiceSetupModal'),
        import('@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility'),
      ]);
      await presentConnectSheet({
        scope,
        service: BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID.github.service,
        intent: 'link',
      });
      // The SCM owner reads the repaired credential; the starter and writing stay in this screen.
      forge.recheck();
    })();
  }, [forge.recheck, scope]);
  // Code lives on · <forge> · owner/name · Private (journey-deploy F5). The forge is a choice only when more than one fits.
  const forgeTitle = forge.forges.find((candidate) => candidate.providerKind === forge.chosen)?.title
    ?? (owner.kind === 'ready' ? owner.target.provider.displayName : owner.kind === 'loading' ? null : owner.providerName)
    ?? forge.chosen ?? '';
  const codeLivesOnLine = owner.kind === 'ready'
    ? [forge.forges.length > 1 ? null : forgeTitle, `${owner.owner}/${repositoryName || '…'}`, t('newApp.privateRepository')]
      .filter(Boolean).join(' · ')
    : owner.kind === 'loading' ? '—'
      : owner.kind === 'needsAccount' ? t('newApp.forgeNeeded', { forge: forgeTitle })
        : t('newApp.forgeUnavailable', { forge: forgeTitle });
  const forgeChoice = forge.forges.length > 1 ? (
    <ValueFieldSelect
      testID="newApp.forge"
      label={t('newApp.codeLivesOn')}
      items={forge.forges.map((candidate) => ({ id: candidate.providerKind, title: candidate.title,
        ...forgeOptionLine(forge.ownerOf(candidate.providerKind), repositoryName) }))}
      selectedId={forge.chosen}
      onSelect={forge.choose}
    />
  ) : null;
  // The one way on when the chosen forge can't take the repository yet: connect GitHub here, or check again.
  const forgeRepair = owner.kind === 'needsAccount' && forge.chosen === DEFAULT_PROJECT_REPOSITORY_PROVIDER_KIND_V1 ? (
    <RoundButton testID="newApp.connectGithub" size="small" display="inverted"
      title={t('newApp.connectGithub')} onPress={connectGithub} />
  ) : (owner.kind === 'needsAccount' || owner.kind === 'unavailable') && machine ? (
    <RoundButton testID="newApp.recheckGithub" size="small" display="inverted"
      title={t('newApp.retry')} onPress={forge.recheck} />
  ) : null;
  const addComputer = React.useCallback(() => {
    setMachineHomeMismatch(false);
    setAddingMachine(true);
  }, []);
  const returnFromMachineSetup = React.useCallback(() => setAddingMachine(false), []);
  const selectAddedMachine = React.useCallback((added: Readonly<{ machineId: string; serverId: string }>) => {
    if (!scope || !areServerProfileIdentifiersEquivalent(added.serverId, scope.serverId)) {
      setMachineHomeMismatch(true);
      return false;
    }
    setMachineHomeMismatch(false);
    setMachineId(added.machineId);
    setAddingMachine(false);
    return true;
  }, [scope]);

  const startSession = React.useCallback(
    async (
      outcome: Extract<StarterCreateOutcome, { kind: 'created' }>,
    ): Promise<boolean> => {
      const lifetime = captureActiveServerAccountScopeLifetime();
      if (!scope || !lifetime) return false;
      // The existing New session owner takes it from here: the description is the first message, in the
      // new checkout, with the person's agent and model defaults (P60-R2: no second Session path).
      const opened = await openSessionAuthoringAction({
        seed: {
          placement: {
            kind: 'exactTarget',
            serverId: scope.serverId,
            machineId: outcome.handoff.machineId,
            directory: outcome.handoff.directory,
          },
          prompt: outcome.handoff.initialMessage,
          ...(name.trim() ? { sessionName: name.trim() } : {}),
        },
      }, lifetime);
      return opened.kind === 'opened';
    },
    [name, scope],
  );

  const submit = React.useCallback(async (retry = false) => {
    const reviewedInput = retry ? submittedInput.current ?? input : input;
    if (!reviewedInput || !scope) return;
    const actionInput = retry && create?.kind === 'failed' && create.resume
      ? { ...reviewedInput, resume: create.resume }
      : reviewedInput;
    // A visible retry keeps the submitted operands, including an earlier continuation after transport failure.
    submittedInput.current = actionInput;
    setStep('create');
    setCreate({ kind: 'running' });
    const suggestion = appliedSuggestion && (actionInput.source?.kind === 'scratch'
      ? appliedSuggestion.recommendation.source.kind === 'scratch'
      : suggestedStarterItemId(appliedSuggestion) === actionInput.starterId) ? appliedSuggestion : null;
    const lifetime = suggestion ? captureActiveServerAccountScopeLifetime() : null;
    if (suggestion && lifetime) {
      // Use this setup: the suggestion owner creates through the same Action with the plan brief, then opens the Session.
      const { serverId: _serverId, starterId: _starterId, source: _source, description: _description, ...createInput } = actionInput;
      // The brief names the forge the person kept, which the validator admitted with this target.
      const applied = await applyDeploySuggestion({ serverId: scope.serverId,
        suggestion: { ...suggestion.recommendation, repositoryProviderKind: actionInput.repository.providerKind },
        catalog: suggestion.catalog, description: auto.description,
        create: { input: createInput, lifetime, ...(name.trim() ? { sessionName: name.trim() } : {}) } });
      if (applied.kind === 'created') {
        if (applied.sessionOpened) stepAside();
        else setCreate({ kind: 'projectReady', created: applied.creation });
        return;
      }
      const settled = applied.kind === 'failed' && applied.creation
        ? applied.creation
        : readStarterCreateOutcome({ kind: 'failed', code: applied.kind === 'failed' ? applied.code : applied.kind }, actionInput.resume);
      setCreate(settled);
      if (settled.kind === 'needsScmAccount') {
        forge.markNeedsAccount();
        setStep('describe');
      }
      return;
    }
    let outcome: StarterCreateOutcome;
    try {
      const execute = createFrontDoorUiActionExecutor(undefined, {
        serverId: scope.serverId,
        expectedAccountId: scope.accountId,
      });
      // This review is the Action's designed confirmation (uiConfirmation: 'direct').
      outcome = readStarterCreateOutcome(
        await execute(CREATE_ACTION, actionInput, { confirmed: true }),
        actionInput.resume,
      );
    } catch (error) {
      const code =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : 'starter_create_failed';
      outcome = readStarterCreateOutcome({ kind: 'failed', code }, actionInput.resume);
    }
    setCreate(outcome);
    if (outcome.kind === 'needsScmAccount') {
      forge.markNeedsAccount();
      setStep('describe');
      return;
    }
    if (outcome.kind === 'created') {
      if (await startSession(outcome)) stepAside();
      else setCreate({ kind: 'projectReady', created: outcome });
    }
  }, [appliedSuggestion, auto.description, create, forge.markNeedsAccount, input, name, scope, startSession, stepAside]);

  // Use this setup (journey-deploy F4): the suggestion owner routes it. A starter continues in this flow's review, which
  // creates through the owner with the plan brief; a catalog app continues in this dialog's Where it runs.
  const applyChosenSuggestion = async () => {
    const chosen = auto.chosen;
    if (!chosen || !scope) return;
    const applied = await applyDeploySuggestion({ serverId: scope.serverId, suggestion: chosen.recommendation,
      catalog: chosen.catalog, description: auto.description });
    const source = chosen.recommendation.source;
    if (applied.kind === 'where') {
      // A catalog app is a pure deploy: Where it runs in this dialog, its suggested target already chosen.
      startDeploy({ kind: 'catalogApp', app: applied.app, targetId: applied.targetId });
      return;
    }
    if (applied.kind === 'needsCreateInput') {
      // A starter or scratch setup builds code: it continues in this flow's review (Code lives on, Built by), then a Session.
      setAppliedSuggestion(chosen);
      setDescription(auto.description);
      setStarterId(source.kind === 'starter' ? suggestedStarterItemId(chosen) : null);
      setPickedStarter(null);
      setCodeSourceId(null);
      setDoor(null);
      setPastedRepository(null);
      setStep('describe');
    }
  };
  const applySuggestionRef = React.useRef(applyChosenSuggestion);
  applySuggestionRef.current = applyChosenSuggestion;

  const back = React.useCallback(() => {
    if (addingMachine) setAddingMachine(false);
    else if (step === 'deploy') {
      if (deployFrame) deployFrame.back();
      else leaveDeploy();
    }
    else if (step === 'describe') setStep('start');
    else if (step === 'auto') {
      auto.stop();
      setStep('start');
    }
    else if (
      step === 'create' &&
      (create?.kind === 'failed' || create?.kind === 'outcomeUnknown')
    )
      setStep('describe');
    else close();
  }, [addingMachine, auto.stop, close, create?.kind, deployFrame, leaveDeploy, step]);
  const pageBack = usePageBackControl('newApp.back', back);

  const deployStep = step === 'deploy' ? deployFrame?.step ?? 'where' : null;
  // The deploy steps count the source step first, then the draft's own (journey-deploy: four dots).
  // Describe your app is the source step's other way in: the same first dot of the same stepper.
  const stepIndex = deployStep ? 1 + DEPLOY_STEPS.indexOf(deployStep) : step === 'auto' ? 0 : STEPS.indexOf(step);
  const stepCount = step === 'deploy' ? 1 + DEPLOY_STEPS.length : STEPS.length;
  // With nothing to pick, the state's own next step (Add a computer, Retry) is the only action. Your code continues
  // in that Project's own new-Environment draft (lab f1cfg); a starter continues here.
  const autoKind = auto.view.kind;
  const adjustingNow = adjusting && autoKind === 'recommendations' && auto.chosen !== null;
  const primary = addingMachine ? null :
    step === 'deploy'
      ? deployFrame ? { ...deployFrame.primary, onPress: deployFrame.press } : null
      : step === 'auto'
      ? autoKind === 'describe'
        ? { title: t('newApp.auto.suggest'), disabled: !auto.description.trim() || !scope, onPress: auto.suggest, testID: 'newApp.auto.suggest' }
        : autoKind === 'recommendations'
          ? { title: t('newApp.auto.useSetup'), disabled: auto.chosen === null, onPress: () => { void applySuggestionRef.current(); }, testID: 'newApp.auto.useSetup' }
          : autoKind === 'noAgent'
            ? { title: t('newApp.auto.addMachine'), disabled: false, onPress: addComputer, testID: 'newApp.auto.addMachine' }
          : autoKind === 'questions'
            ? { title: t('newApp.auto.suggestAgain'), disabled: !questionAnswers?.ready,
                onPress: () => { if (questionAnswers?.ready) auto.answerQuestions(questionAnswers.answers); }, testID: 'newApp.auto.suggestAgain' }
            : null
      : step === 'start'
      ? {
          title: t('common.continue'),
          disabled: savingSource || (!starter && codeSourceId === null && door === null && pastedRepository === null),
          onPress: () => {
            if (pastedRepository !== null && scope) {
              // The pasted repository is the deploy source: kept as this Home's Source, then its deploy steps here.
              setSavingSource(true);
              void pastedRepository.save().then((source) => {
                setSavingSource(false);
                if (source) startDeploy({ kind: 'repository', projectSourceId: source.id });
              });
              return;
            }
            if (door !== null) {
              continueThroughDoor(door);
              return;
            }
            if (codeSourceId !== null) {
              startDeploy({ kind: 'repository', projectSourceId: codeSourceId });
              return;
            }
            setStep('describe');
          },
          testID: 'newApp.continue',
        }
      : step === 'describe'
        ? {
            title: t('newApp.create'),
            disabled: !input,
            onPress: () => {
              void submit();
            },
            testID: 'newApp.create',
          }
        : create?.kind === 'projectReady'
          ? {
              title: t('newApp.startBuilding'),
              disabled: false,
              onPress: () => {
                void startSession(create.created).then((ok) => {
                  if (ok) stepAside();
                });
              },
              testID: 'newApp.startBuilding',
            }
        : create?.kind === 'failed' || create?.kind === 'outcomeUnknown'
          ? {
              title: t('newApp.retry'),
              disabled: !submittedInput.current && !input,
              onPress: () => {
                void submit(true);
              },
              testID: 'newApp.retry',
            }
          : null;
  const footerNote = addingMachine ? null :
    // A phone footer has room for the actions only (lab autoNoAgentp, autoThinkp).
    step === 'auto'
      ? phone ? null
        : autoKind === 'working' ? t('newApp.auto.workingNote')
        : autoKind === 'recommendations' ? auto.suggestedBy
        : autoKind === 'noAgent' ? t('newApp.auto.descriptionKept')
        : null :
    deployStep === 'where' || deployStep === 'configure' ? t('newApp.deploy.nothingCreated') :
    deployStep === 'review' && deployFrame?.refused ? t('newApp.deploy.plan.nothingWasCreated') :
    step === 'start' && !starter && codeSourceId === null && door === null && pastedRepository === null
      ? t('newApp.startPick')
      : step === 'describe'
        ? t('newApp.reviewNote')
        : null;
  // A selected managed creation owns Cancel, including its disabled state while acquisition is pending.
  const machineOwnsExit = addingMachine && machineCreationDraft !== null;
  const showBack = !machineOwnsExit && (
    (step === 'auto' && (autoKind === 'describe' || autoKind === 'nothing' || autoKind === 'failed')) ||
    step === 'deploy' ||
    step === 'describe' ||
    (step === 'create' && (create?.kind === 'failed' || create?.kind === 'outcomeUnknown'))
  );
  // The step's quieter ways out, before Back and the primary (lab autoThink: Stop · Close; autoNoAgent: Choose a starter myself).
  const autoStop = auto.view.kind === 'working' ? (typeof auto.view.stop === 'object' ? 'refused' : auto.view.stop) : null;
  const autoSecondary: ReadonlyArray<Readonly<{ title: string; testID: string; onPress: () => void; loading?: boolean; disabled?: boolean }>> | null =
    step !== 'auto' || addingMachine ? null
    : adjustingNow ? [
        { title: t('common.back'), testID: 'newApp.auto.adjustBack', onPress: () => setAdjusting(false) },
        { title: t('newApp.auto.suggestAgain'), testID: 'newApp.auto.suggestAgain', disabled: !adjustNote.trim(),
          onPress: () => { const note = adjustNote.trim(); if (!note) return; setAdjusting(false); setAdjustNote(''); auto.suggestAgain(note); } },
      ]
    : autoKind === 'recommendations' ? [{ title: t('newApp.auto.adjust'), testID: 'newApp.auto.adjust', disabled: auto.chosen === null,
        onPress: () => setAdjusting(true) }]
    : autoKind === 'working' ? [
        // A refused Stop's Retry lives in its notice; while Stop is asked, the button waits for its answer.
        ...(autoStop === 'refused' ? [] : [{ title: t('newApp.auto.stop'), testID: 'newApp.auto.stop', onPress: () => auto.stop(),
          loading: autoStop === 'stopping' }]),
        { title: t('common.close'), testID: 'newApp.auto.close', onPress: () => closeRef.current() },
      ]
    : autoKind === 'noAgent' || autoKind === 'questions' ? [{ title: t('newApp.auto.chooseStarter'), testID: 'newApp.auto.chooseStarter', onPress: () => backRef.current() }]
    : null;
  const primaryRef = React.useRef(primary);
  primaryRef.current = primary;
  const backRef = React.useRef(back);
  backRef.current = back;
  const closeRef = React.useRef(close);
  closeRef.current = close;


  // In the dialog the card's own title band carries each step's title, purpose and step dots (lab f1src): one title,
  // no second heading under it. As a page, the page header does.
  let heading: Readonly<{ title: string; description: string }> | null = null;
  const header = (title: string, descriptionText: string) => {
    heading = { title, description: descriptionText };
    return dialog ? null : (
      <NavigationBackChromeProvider control={machineOwnsExit ? null : pageBack}>
        <PageHeader title={title} description={descriptionText} alwaysShowTitle />
      </NavigationBackChromeProvider>
    );
  };


  let body: React.ReactNode;
  if (addingMachine && scope) {
    body = (
      <View testID="newApp.addMachine">
        {header(t('newApp.addComputer'), t('newApp.computerNeeded'))}
        {machineHomeMismatch ? (
          <SurfaceStateCard testID="newApp.machineHomeMismatch" kind="unavailable" layout="inline"
            title={t('newApp.machineHomeMismatch')} />
        ) : null}
        <React.Suspense fallback={<SurfaceStateCard kind="loading" layout="inline" title={t('common.loading')} />}>
          <NewAppMachineSetup serverId={scope.serverId} draft={machineCreationDraft}
            onDraftChange={setMachineCreationDraft} onArrived={selectAddedMachine} onCancel={returnFromMachineSetup} />
        </React.Suspense>
      </View>
    );
  } else if (step === 'start') {
    body = (
      <>
        {header(t('newApp.startTitle'), t('newApp.startDescription'))}
        {scope ? (
          <View>
            <NewAppCodeSources scope={scope} value={codeSourceId} onChange={chooseCode} columns={phone ? 1 : 2}
              chosenRepository={pastedRepository?.selector ?? null} onChooseRepository={choosePastedRepository}
              query={query} onQueryChange={setQuery} />
          </View>
        ) : null}
        {/* Until the catalog owner has an answer the gallery is reading, never empty (it held "Nothing here yet" for
            ~40 s on #136 before its sources settled as unreachable). The states share the tiles' group and inset. */}
        <View>
        {search && starterCatalog.hasValue && !starterCatalog.loading && starters.length === 0 ? null : (
        <ItemGroup surface="none" title={t('newApp.startNew')} titleRole="label"
          action={<TextLinkButton testID="newApp.allStarters" size="meta" label={t('newApp.allStarters')} onPress={browseStarters} />}>
        {/* Describe your app sits a tile gap above the starters (lab .jd-descopt), not flush against them. */}
        <View style={styles.startNewStack}>
        {/* Describe your app: one full-width choice above the starters (lab src DESCRIBE_ENTRY), chosen like the rest. */}
        <SelectionTiles
          density="compact"
          testIdPrefix="newApp.door"
          maximumColumns={1}
          subtitleLines={2}
          accessibilityLabel={t('newApp.auto.entryTitle')}
          value={door === 'describe' ? 'describe' : null}
          onChange={(next) => chooseDoor(next === 'describe' ? 'describe' : null)}
          options={[{ id: 'describe', testID: 'newApp.describeApp', icon: 'sparkle',
            title: t('newApp.auto.entryTitle'), subtitle: t('newApp.auto.entrySubtitle') }]}
        />
        {(starterCatalog.loading || !starterCatalog.hasValue) && !starterCatalog.error && starters.length === 0 ? (
          <SurfaceStateCard testID="newApp.loading" kind="loading" layout="inline" title={t('common.loading')} />
        ) : null}
        {/* One cause, one line: starters are read on a Machine, so a person without one online is offered the
            Add a computer flow that keeps this draft, instead of one Retry card per source. */}
        {startersNeedMachine ? (
          <SurfaceStateCard
            testID="newApp.needsMachine"
            kind="unavailable"
            layout="inline"
            title={t('newApp.startersNeedMachine')}
            reason={t('newApp.startersNeedMachineBody')}
            action={{ label: t('newApp.auto.addMachine'), onPress: addComputer }}
          />
        ) : null}
        {starterCatalog.sourceFailures.filter((failure) => failure.status.state !== 'needs_machine' || starters.length > 0).map((failure) => (
          <SurfaceStateCard
            key={failure.sourceId}
            testID={`newApp.catalogFailure:${failure.sourceId}`}
            kind="error"
            layout="inline"
            title={t('capabilities.store.listing.failed')}
            reason={failure.message}
            action={{ label: t('common.retry'), onPress: failure.onRetry }}
          />
        ))}
        {starterCatalog.error ? (
          <SurfaceStateCard
            testID="newApp.catalogFailure"
            kind="error"
            layout="inline"
            title={t('capabilities.store.listing.failed')}
            reason={starterCatalog.error}
            action={{ label: t('common.retry'), onPress: starterCatalog.refresh }}
          />
        ) : null}
        {startersSettledEmpty && !startersNeedMachine ? (
          // Inside the picker an empty group is one quiet line; Describe your app above stays the way to start.
          <EmptyState testID="newApp.startersEmpty" layout="line" title={t('newApp.noStarters')} />
        ) : null}
            {starters.length > 0 ? (
              <SelectionTiles
                density="compact"
                testIdPrefix="newApp.starter"
                maximumColumns={phone ? 1 : 3}
                // A starter's one-sentence description reads whole, like a catalog listing's first clause.
                subtitleLines={4}
                accessibilityLabel={t('newApp.startNew')}
                value={starterId}
                onChange={chooseStarter}
                options={starters.map((candidate) => starterTile(candidate))}
              />
            ) : null}
          </View>
        </ItemGroup>
        )}
        </View>
        {/* Lab f1src Already built and From the catalog: an app that already exists runs without a repository. */}
        {scope ? (
          <View>
            <ItemGroup testID="newApp.built" surface="none" title={t('newApp.alreadyBuilt')} titleRole="label">
              <View>
                <SelectionTiles
                  density="compact"
                  maximumColumns={phone ? 1 : 2}
                  subtitleLines={2}
                  accessibilityLabel={t('newApp.alreadyBuilt')}
                  value={door}
                  onChange={chooseDoor}
                  options={builtTiles}
                />
              </View>
            </ItemGroup>
            <ItemGroup
              testID="newApp.catalog"
              surface="none"
              title={t('newApp.fromCatalog')}
              titleRole="label"
              action={<TextLinkButton testID="newApp.fromCatalog" size="meta" label={t('newApp.browseCatalog')} onPress={browseCatalog} />}
            >
              {catalogTiles.length > 0 ? (
                <View>
                  <SelectionTiles
                    density="compact"
                    // One rhythm: two columns in every section of the dialog (journey-deploy jdF-src).
                    maximumColumns={phone ? 1 : 2}
                    // A listing's first clause fits whole (the longest seen, ~95 characters, takes four lines).
                    subtitleLines={4}
                    accessibilityLabel={t('newApp.fromCatalog')}
                    value={door}
                    onChange={chooseDoor}
                    options={catalogTiles}
                  />
                </View>
              ) : null}
            </ItemGroup>
          </View>
        ) : null}
        {props.onClone ? (
          <View style={styles.haveCode}>
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
              {t('newApp.haveCode')}
            </Text>
            <TextLinkButton
              testID="newApp.clone"
              size="meta"
              label={t('newApp.clone')}
              onPress={() => {
                stepAside();
                props.onClone?.();
              }}
            />
          </View>
        ) : null}
      </>
    );
  } else if (step === 'deploy' && deploySource && scope) {
    const named = deployFrame?.source?.title ?? null;
    const name = deployFrame?.appName ?? null;
    const target = deployFrame?.runsOn?.title ?? null;
    const [title, description] = deployStep === 'review'
      ? [name && target ? t('newApp.deploy.reviewTitle', { name, target }) : target ? t('newApp.deploy.reviewTitleUnnamed', { target }) : t('newApp.title'),
        t('newApp.deploy.reviewDescription')]
      : deployStep === 'configure'
        ? [t('newApp.title'), !name || !target ? t('newApp.deploy.configureUnnamed') : deployFrame?.runsOn?.kind === 'platform'
          ? t('newApp.deploy.configurePlatform', { name, target }) : t('newApp.deploy.configureMachine', { name, machine: target })]
        : [t('newApp.title'), name ? t('newApp.deploy.whereDescription', { name }) : t('newApp.deploy.whereDescriptionUnnamed')];
    body = (
      <View testID="newApp.deploy">
        {header(title, description)}
        <NewAppDeploySummary phone={phone} frame={deployFrame} onChangeSource={leaveDeploy}
          source={deploySource.kind === 'definition'
            ? { title: t(deploySource.definitionKind === 'image' ? 'newApp.deploy.builtImageSource' : 'newApp.deploy.builtComposeSource'), note: null }
            : { title: named ?? pastedRepository?.selector.repository.nameWithOwner ?? '…', note: deployFrame?.source?.note ?? null }} />
        <NewAppDeploySteps serverId={scope.serverId} source={deploySource} machineId={props.machine?.machineId ?? null}
          previewEnvironmentId={deploySource.kind === 'repository' && deploySource.projectSourceId === props.projectSourceId
            ? props.previewEnvironmentId : null}
          phone={phone} steps={deploySteps} onLeave={stepAside} />
      </View>
    );
  } else if (step === 'auto') {
    const recommending = auto.view.kind === 'recommendations';
    const chosenCard = auto.view.kind === 'recommendations' ? auto.view.cards.find((card) => card.id === auto.chosenCardId) ?? null : null;
    body = adjustingNow && auto.chosen && chosenCard ? (
      <>
        {header(t('newApp.auto.adjustTitle'), t('newApp.auto.adjustDescription'))}
        <NewAppAutoAdjust chosen={auto.chosen} title={chosenCard.title}
          source={auto.view.kind === 'recommendations' ? auto.view.source : null}
          note={adjustNote} onNoteChange={setAdjustNote} adjust={auto.adjustChosen}
          onEditDescription={auto.backToDescription} phone={phone} insetStyle={dialog ? styles.dialogInset : null} />
      </>
    ) : (
      <>
        {recommending
          ? header(t('newApp.auto.recommendationsTitle'), t('newApp.auto.recommendationsDescription', {
              count: auto.view.kind === 'recommendations' ? auto.view.cards.length : 0 }))
          : header(t('newApp.auto.title'), t(auto.view.kind === 'questions' ? 'newApp.auto.questionsDescription' : 'newApp.auto.description'))}
        <NewAppAutoStep
          view={auto.view}
          description={auto.description}
          onDescriptionChange={auto.setDescription}
          chosenCardId={auto.chosenCardId}
          onChooseCard={auto.chooseCard}
          onEditDescription={auto.backToDescription}
          onTryAgain={auto.suggest}
          onChooseStarter={back}
          onQuestionState={setQuestionAnswers}
          phone={phone}
          insetStyle={dialog ? styles.dialogInset : null}
        />
      </>
    );
  } else if (step === 'describe') {
    body = (
      <>
        {header(t('newApp.describeTitle'), t('newApp.describeDescription'))}
        <ItemGroup surface="none">
          <View style={dialog ? styles.dialogInset : null}>
            <FieldTextInput
              testID="newApp.description"
              value={description}
              onChangeText={setDescription}
              accessibilityLabel={t('newApp.describeLabel')}
              placeholder={t('newApp.describePlaceholder')}
              multiline
              minLines={phone ? 5 : 4}
              growWithText
              autoFocus={!phone}
            />
          </View>
        </ItemGroup>
        <ItemGroup>
          <Item
            testID="newApp.name"
            title={t('newApp.name')}
            accessoryLayout="adaptive"
            showChevron={false}
            rightElement={
              <FieldTextInput
                testID="newApp.nameField"
                value={name}
                onChangeText={setName}
                accessibilityLabel={t('newApp.name')}
                placeholder={t('newApp.namePlaceholder')}
              />
            }
          />
          <Item
            testID="newApp.repository"
            title={t('newApp.codeLivesOn')}
            showChevron={false}
            subtitle={codeLivesOnLine}
            subtitleLines={0}
            {...(forgeChoice ? { accessoryLayout: 'adaptive' as const } : {})}
            rightElement={forgeChoice ?? forgeRepair}
          />
          {forgeChoice && forgeRepair ? (
            <View style={styles.forgeRepair}>{forgeRepair}</View>
          ) : null}
          {machines.length === 0 ? (
            <Item
              testID="newApp.machine"
              title={t('newApp.builtBy')}
              subtitle={t('newApp.computerNeeded')}
              subtitleLines={0}
              showChevron={false}
              rightElement={
                <RoundButton
                  testID="newApp.addComputer"
                  size="small"
                  display="inverted"
                  title={t('newApp.addComputer')}
                  onPress={addComputer}
                />
              }
            />
          ) : (
            // The folder is the app's own checkout under the Machine's projects folder, so only the Machine is asked.
            <SessionMachineField
              testID="newApp.machine"
              serverId={scope?.serverId ?? ''}
              machines={machines}
              machineId={effectiveMachineId}
              title={t('newApp.builtBy')}
              {...(homeDir && repositoryName
                ? { subtitle: formatPathRelativeToHome(`${projectCheckoutParentPath(homeDir)}/${repositoryName}`, homeDir) }
                : {})}
              onSelectMachine={(next) => setMachineId(next.id)}
            />
          )}
        </ItemGroup>
        {starter ? (
          <ItemGroup>
            <ExpandableItem
              expanded={detailsOpen}
              onExpandedChange={setDetailsOpen}
              header={({ headerProps }) => (
                <Item
                  {...headerProps}
                  testID="newApp.details"
                  title={t('newApp.details')}
                  detail={starter.appMetadata?.tags?.join(' · ') ?? ''}
                />
              )}
            >
              <View>
                <Item
                  mode="info"
                  title={t('newApp.detailStarter')}
                  detail={starter.title}
                  showChevron={false}
                />
                <Item
                  mode="info"
                  title={t('newApp.detailBuiltWith')}
                  detail={starter.appMetadata?.tags?.join(' · ') ?? ''}
                  showChevron={false}
                />
                <Item
                  mode="info"
                  title={t('newApp.detailBranch')}
                  detail="main"
                  showChevron={false}
                />
                <Item
                  mode="info"
                  title={t('newApp.detailAction')}
                  detail={CREATE_ACTION}
                  showChevron={false}
                />
              </View>
            </ExpandableItem>
          </ItemGroup>
        ) : null}
      </>
    );
  } else {
    const appName = name.trim() || repositoryName;
    body = (
      <>
        {create?.kind === 'projectReady'
          ? header(t('newApp.readyTitle'), t('newApp.readyDescription'))
          : header(
              t('newApp.creatingTitle', { name: appName }),
              // After a stop, the purpose line says what is already done; the card says what stopped.
              create?.kind === 'failed'
                ? t(create.repositoryCreated ? 'newApp.failedKept' : 'newApp.failedNothing')
                : t('newApp.creatingDescription'),
            )}
        {create?.kind === 'projectReady' ? null : create?.kind === 'failed' ? (
          <SurfaceStateCard
            testID="newApp.failed"
            kind="error"
            layout="inline"
            title={t('newApp.failedTitle')}
            reason={create.remediation ?? undefined}
            diagnosticCode={create.code}
          />
        ) : create?.kind === 'outcomeUnknown' ? (
          <AttentionBanner
            testID="newApp.unknown"
            tone="warning"
            placement="page-section"
            title={t('newApp.outcomeUnknown')}
            action={
              create.repositoryUrl
                ? {
                    label: t('newApp.checkRepository'),
                    onPress: () => {
                      void openExternalUrl(create.repositoryUrl!);
                    },
                  }
                : null
            }
          />
        ) : (
          <SurfaceStateCard
            testID="newApp.creating"
            kind="loading"
            layout="inline"
            title={t('newApp.keepsGoing')}
          />
        )}
      </>
    );
  }

  const settledHeading = heading as Readonly<{ title: string; description: string }> | null;
  const headingTitle = settledHeading?.title ?? t('newApp.title');
  const headingDescription = settledHeading?.description ?? null;
  const dialogChrome = React.useMemo(
    () =>
      dialog
        ? {
            kind: 'card' as const,
            // Each step, and each settled phase of Describe your app, is its own screen: the card fits it.
            screenKey: step === 'auto' ? `auto:${autoKind}` : deployStep ? `deploy:${deployStep}` : step,
            title: headingTitle,
            subtitle: headingDescription,
            actions: <WizardStepDots currentStepIndex={stepIndex} stepCount={stepCount} />,
            footer: (
              <ModalCardFooterActions note={footerNote}>
                {step === 'start' && !addingMachine ? (
                  <RoundButton
                    testID="newApp.cancel"
                    size="small"
                    display="inverted"
                    title={t('common.cancel')}
                    onPress={() => closeRef.current()}
                  />
                ) : null}
                {autoSecondary?.map((action) => (
                  <RoundButton key={action.testID} testID={action.testID} size="small" display="inverted"
                    title={action.title} loading={action.loading ?? false} disabled={action.disabled ?? false} onPress={action.onPress} />
                ))}
                {showBack ? (
                  <RoundButton
                    testID="newApp.back"
                    size="small"
                    display="inverted"
                    title={t('common.back')}
                    onPress={() => backRef.current()}
                  />
                ) : null}
                {primary ? (
                  <RoundButton
                    testID={primary.testID}
                    size="small"
                    title={primary.title}
                    disabled={primary.disabled}
                    loading={'loading' in primary ? primary.loading : false}
                    onPress={() => primaryRef.current?.onPress()}
                  />
                ) : null}
              </ModalCardFooterActions>
            ),
          }
        : null,
    [
      dialog,
      footerNote,
      primary?.disabled,
      primary && 'loading' in primary ? primary.loading : false,
      primary?.testID,
      primary?.title,
      step,
      autoKind,
      autoStop,
      adjustingNow,
      adjustNote.trim() === '',
      showBack,
      addingMachine,
      stepIndex,
      stepCount,
      headingTitle,
      headingDescription,
    ],
  );
  useModalCardChrome(props.setChrome, dialogChrome);

  return (
    <View testID="newApp" style={styles.root}>
      {/* Starters need each installation's registry sources, not every plugin's UI (cold open: ~75 serial frames). */}
      <PluginSurfaceProjectionDemand accountScope={scope} presents="allInstallations" sections={REGISTRY_SOURCE_PROJECTION_SECTIONS}
        enabled={step === 'start'} />
      <ItemList testID="newApp.body" style={styles.list}>
        {body}
      </ItemList>
      {dialog || (!primary && !autoSecondary) ? null : (
        <KeyboardStickyFooter>
          {/* On a wide page the bar's contents stand on the page's content column (QA #35), not across the pane. */}
          <PagePinnedBar style={phone ? styles.phoneFooter : [styles.wideFooter, { maxWidth: pageMaxWidth }]}>
            {footerNote ? (
              <Text
                variant="meta"
                numberOfLines={1}
                style={{ color: theme.colors.text.secondary }}
              >
                {footerNote}
              </Text>
            ) : null}
            {autoSecondary?.map((action) => (
              <RoundButton key={action.testID} testID={action.testID} size="normal" display="inverted"
                title={action.title} loading={action.loading ?? false} disabled={action.disabled ?? false} onPress={action.onPress} />
            ))}
            {primary ? (
              <RoundButton
                testID={primary.testID}
                size="normal"
                title={primary.title}
                disabled={primary.disabled}
                onPress={primary.onPress}
              />
            ) : null}
          </PagePinnedBar>
        </KeyboardStickyFooter>
      )}
    </View>
  );
});

/** The line under a forge in Code lives on's menu: where the repository would go, or nothing while it is checked. */
function forgeOptionLine(owner: ForgeOwnerFact | undefined, repositoryName: string): { subtitle?: string } {
  return owner?.kind === 'ready' ? { subtitle: `${owner.owner}/${repositoryName || '…'}` } : {};
}

/** The registry item a suggested starter names: the catalog snapshot carries the item id the review selects by. */
function suggestedStarterItemId(chosen: NewAppAutoChosen): string | null {
  const source = chosen.recommendation.source;
  if (source.kind !== 'starter') return null;
  return chosen.catalog.starters.find((starter) => starter.id === source.starterId)?.itemId ?? source.starterId;
}

function starterTile(starter: RegistryCatalogItemSummary) {
  return {
    id: starter.itemId,
    title: starter.title,
    subtitle: starter.description,
    icon: 'sparkle' as const,
  };
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  list: { flex: 1 },
  haveCode: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s4,
  },
  // The lab sets the run-existing row a clear step below the gallery, not tight under its captions.
  ways: { gap: theme.space.s8, paddingTop: theme.space.s20, paddingHorizontal: theme.space.s16 },
  waysEntries: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 },
  // The card has no page gutter, and a bare group bleeds one step past the card body there. The description field
  // takes that step back so it shares the edge of the sheets beneath it. The start step's search field and tiles take
  // none: they stand on the dialog title's edge with their section titles (journey-deploy jdF-src, one edge).
  dialogInset: { paddingHorizontal: theme.space.s16 },
  startNewStack: { gap: theme.space.s8 },
  forgeRepair: { alignItems: 'flex-end', paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s12 },

  phoneFooter: { gap: theme.space.s8 },
  wideFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.s12,
    width: '100%', marginHorizontal: 'auto' },
}));

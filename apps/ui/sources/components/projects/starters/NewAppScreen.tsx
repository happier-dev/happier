import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { PluginSurfaceProjectionDemand } from '@/components/plugins/surfaces/PluginSurfaceProjectionDemand';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SelectionTiles, type SelectionTile } from '@/components/ui/forms/SelectionTiles';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { NavigationBackChromeProvider } from '@/components/ui/layout/NavigationBackChrome';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
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
import { machineScmHostingRepositoryDescribePublishTargets } from '@/sync/ops/scm/machineScm';
import type { ScmHostingRepositoryDescribePublishTargetsResponse } from '@happier-dev/protocol/scm';
import { resolveSourceControlPublishRepositoryRemediation } from '@/components/workspaces/scm/update/resolveSourceControlPublishRepositoryRemediation';
import {
  createFrontDoorUiActionExecutor,
  createFrontDoorActionExecute,
} from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
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
import { buildProjectRepositoryOpenRoute } from '../activation/projectOpenRoute';
import type { ProjectSourceRepositorySelectorV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { StoreItemMark } from '@/components/store/catalog/StoreItemMark';
import { useOpenStoreListing } from '@/components/store/StoreListing';
import {
  buildDeploymentNewDefinitionHref,
  buildDeploymentRepositoryDraftHref,
  type DeploymentNewDefinitionKind,
} from '@/components/projects/deployments/deploymentNavigation';
import { NewAppCodeSources } from './NewAppCodeSources';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { QualifiedMachineV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import type { MachineCreationContinuationDraft } from '@/components/machines/add/MachineCreationContinuation';

const NewAppMachineSetup = React.lazy(() => import('./NewAppMachineSetup').then(module => ({ default: module.NewAppMachineSetup })));

type Step = 'start' | 'describe' | 'create';
const STEPS: readonly Step[] = ['start', 'describe', 'create'];
/** Already built (a stored definition the Project draft picks a Project for) or a catalog app's listing. */
type Door = `built:${DeploymentNewDefinitionKind}` | `catalog:${string}`;
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
const SESSION_OPEN_ACTION = 'session.authoring.open' as const;

type OwnerFact =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; owner: string }>
  | Readonly<{ kind: 'needsAccount' }>
  | Readonly<{ kind: 'unavailable' }>;

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
  const search = query.trim();
  const starterCatalog = useRegistryItems(search ? { kind: 'starter', query: search } : { kind: 'starter' }, true);
  const starters = starterCatalog.items;

  const [step, setStep] = React.useState<Step>('start');
  const [starterId, setStarterId] = React.useState<string | null>(
    props.starterId ?? (starters.length === 1 ? starters[0]!.itemId : null),
  );
  // Deploy an app → Your code: a repository Project, chosen instead of a starter (lab f1src). One choice at a time.
  const [codeSourceId, setCodeSourceId] = React.useState<string | null>(null);
  // Already built and From the catalog (lab f1src): a way that continues outside this dialog, chosen like the others.
  const [door, setDoor] = React.useState<Door | null>(null);
  // Your code → a pasted link to a repository that is not a Project here yet (owner ruling 20:50Z).
  const [pastedRepository, setPastedRepository] = React.useState<ProjectSourceRepositorySelectorV1 | null>(null);
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
  const choosePastedRepository = React.useCallback((selector: ProjectSourceRepositorySelectorV1) => {
    setPastedRepository(selector);
    setStarterId(null);
    setCodeSourceId(null);
    setDoor(null);
  }, []);
  // The catalog's first apps, read only while the person is choosing a way in.
  const appCatalog = useRegistryItems(search ? { kind: 'app', query: search } : { kind: 'app' }, step === 'start');
  const catalogApps = React.useMemo(() => appCatalog.items.slice(0, CATALOG_TILES), [appCatalog.items]);
  const openStoreListing = useOpenStoreListing();
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
  const [owner, setOwner] = React.useState<OwnerFact>({ kind: 'loading' });
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

  // Code lives in: the default GitHub owner the Machine's SCM owner would publish to.
  const ownerProbe = React.useRef(0);
  const probeOwner = React.useCallback(() => {
    if (!effectiveMachineId || !homeDir) {
      setOwner({ kind: 'unavailable' });
      return;
    }
    const probe = ++ownerProbe.current;
    setOwner((current) =>
      current.kind === 'ready' ? current : { kind: 'loading' },
    );
    void machineScmHostingRepositoryDescribePublishTargets(effectiveMachineId, {
      cwd: homeDir,
      providerKind: 'github',
    })
      .then((response) => {
        if (probe !== ownerProbe.current) return;
        // The Git panel's publish owner decides what a describe answer needs; New app reads the same verdict.
        const targets = response && 'success' in response ? (response as ScmHostingRepositoryDescribePublishTargetsResponse) : null;
        const target = targets?.success === true
          ? targets.targets.find((candidate) => candidate.isDefault) ?? targets.targets[0] ?? null
          : null;
        const verdict = resolveSourceControlPublishRepositoryRemediation({
          targetsResponse: targets, selectedTarget: target, publishFailure: null,
        });
        if (target && verdict.authState !== null && !verdict.authUnavailable) setOwner({ kind: 'ready', owner: target.owner });
        else if (verdict.action !== null || (targets?.success === true && !verdict.authState)) setOwner({ kind: 'needsAccount' });
        else setOwner({ kind: 'unavailable' });
      })
      .catch(() => {
        if (probe === ownerProbe.current) setOwner({ kind: 'unavailable' });
      });
  }, [effectiveMachineId, homeDir]);
  React.useEffect(() => {
    if (step === 'describe') probeOwner();
  }, [probeOwner, step]);

  const repositoryName = deriveRepositoryName(name);
  const input = scope
    ? buildStarterCreateInput(
        { starterId, description, name, machineId: effectiveMachineId },
        {
          serverId: scope.serverId,
          homeDir,
          owner: owner.kind === 'ready' ? owner.owner : null,
          requestKey: intentKeyFor({
            starterId,
            description,
            name,
            machineId: effectiveMachineId,
            owner: owner.kind === 'ready' ? owner.owner : null,
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

  // Already built opens the stored-definition draft, which asks for the Project (lab f1cfg); a catalog app opens its
  // Store listing; Browse shows the whole catalog. Each steps aside first.
  const continueThroughDoor = (chosen: Door) => {
    if (!scope) return;
    if (chosen === 'built:image' || chosen === 'built:compose') {
      stepAside();
      router.push(buildDeploymentNewDefinitionHref({ serverId: scope.serverId, kind: chosen === 'built:image' ? 'image' : 'compose',
        machineId: props.machine?.machineId ?? null }) as never);
      return;
    }
    const item = catalogApps.find((candidate) => catalogDoor(candidate) === chosen);
    if (!item) return;
    stepAside();
    openStoreListing({ type: 'registryItem', kind: item.kind, sourceId: item.sourceId, itemId: item.itemId,
      ...(item.version === undefined ? {} : { version: item.version }) });
  };
  // Lab f1src footer: hand the whole job to an agent. New Session opens with the request written, on the door's
  // Machine when there is one; the person reads it, picks the agent and sends it.
  const askAgent = () => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) return;
    stepAside();
    seedAndOpenNewSession({
      seed: { prompt: t('newApp.askAgentPrompt'),
        ...(props.machine ? { placement: { kind: 'exactTarget', serverId: props.machine.serverId, machineId: props.machine.machineId } } : {}) },
      scope: lifetime.scope,
      isCurrent: lifetime.isCurrent,
      navigateToNewSession: ({ draftId }) => router.push({ pathname: '/new', params: buildNewSessionLaunchRouteParams({ draftId }) } as never),
    });
  };
  const askAgentRef = React.useRef(askAgent);
  askAgentRef.current = askAgent;
  const browseCatalog = () => {
    stepAside();
    router.push(buildPluginsHomeRoute('app', { view: 'kind', kind: 'app', machine: props.machine ?? null }) as never);
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
      probeOwner();
    })();
  }, [probeOwner, scope]);
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
      if (!scope) return false;
      // The existing New session owner takes it from here: the description is the first message, in the
      // new checkout, with the person's agent and model defaults (P60-R2: no second Session path).
      const execute = createFrontDoorActionExecute();
      const result = await execute(
        SESSION_OPEN_ACTION,
        {
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
        },
        {
          surface: 'ui',
          authority: 'present_user',
          serverId: scope.serverId,
          expectedAccountId: scope.accountId,
        },
      ).catch(() => null);
      return result?.ok === true;
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
      setOwner({ kind: 'needsAccount' });
      setStep('describe');
      return;
    }
    if (outcome.kind === 'created') {
      if (await startSession(outcome)) stepAside();
      else setCreate({ kind: 'projectReady', created: outcome });
    }
  }, [create, input, scope, startSession, stepAside]);

  const back = React.useCallback(() => {
    if (addingMachine) setAddingMachine(false);
    else if (step === 'describe') setStep('start');
    else if (
      step === 'create' &&
      (create?.kind === 'failed' || create?.kind === 'outcomeUnknown')
    )
      setStep('describe');
    else close();
  }, [addingMachine, close, create?.kind, step]);
  const pageBack = usePageBackControl('newApp.back', back);

  const stepIndex = STEPS.indexOf(step);
  // With nothing to pick, the state's own next step (Add a computer, Retry) is the only action. Your code continues
  // in that Project's own new-Environment draft (lab f1cfg); a starter continues here.
  const primary = addingMachine ? null :
    step === 'start'
      ? {
          title: t('common.continue'),
          disabled: !starter && codeSourceId === null && door === null && pastedRepository === null,
          onPress: () => {
            if (pastedRepository !== null && scope) {
              stepAside();
              router.push(buildProjectRepositoryOpenRoute(scope.serverId, pastedRepository) as never);
              return;
            }
            if (door !== null) {
              continueThroughDoor(door);
              return;
            }
            if (codeSourceId !== null && scope) {
              stepAside();
              router.push(buildDeploymentRepositoryDraftHref({ serverId: scope.serverId, projectSourceId: codeSourceId,
                machineId: props.machine?.machineId ?? null }) as never);
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
    step === 'start' && !starter && codeSourceId === null && door === null && pastedRepository === null
      ? t('newApp.startPick')
      : step === 'describe'
        ? t('newApp.reviewNote')
        : null;
  // A selected managed creation owns Cancel, including its disabled state while acquisition is pending.
  const machineOwnsExit = addingMachine && machineCreationDraft !== null;
  const showBack = !machineOwnsExit && (
    step === 'describe' ||
    (step === 'create' && (create?.kind === 'failed' || create?.kind === 'outcomeUnknown'))
  );
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
              chosenRepository={pastedRepository} onChooseRepository={choosePastedRepository}
              query={query} onQueryChange={setQuery}
              insetStyle={dialog ? styles.dialogInset : null} />
          </View>
        ) : null}
        {/* Until the catalog owner has an answer the gallery is reading, never empty (it held "Nothing here yet" for
            ~40 s on #136 before its sources settled as unreachable). The states share the tiles' group and inset. */}
        <View>
        {search && starterCatalog.hasValue && !starterCatalog.loading && starters.length === 0 ? null : (
        <ItemGroup surface="none" title={t('newApp.startNew')} titleRole="label">
        <View style={dialog ? styles.dialogInset : null}>
        {(starterCatalog.loading || !starterCatalog.hasValue) && !starterCatalog.error && starters.length === 0 ? (
          <SurfaceStateCard testID="newApp.loading" kind="loading" layout="inline" title={t('common.loading')} />
        ) : null}
        {/* One cause, one line: starters are read on a Machine, so a person without one online is offered the
            Add a computer flow that keeps this draft, instead of one Retry card per source. */}
        {starterCatalog.sourceFailures.some((failure) => failure.status.state === 'needs_machine') && starters.length === 0 ? (
          <SurfaceStateCard
            testID="newApp.needsMachine"
            kind="unavailable"
            layout="inline"
            title={t('newApp.noComputer')}
            reason={t('newApp.computerNeeded')}
            action={{ label: t('newApp.addComputer'), onPress: addComputer }}
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
        {!search && starterCatalog.hasValue && !starterCatalog.loading && !starterCatalog.error && starterCatalog.sourceFailures.length === 0 && starters.length === 0 ? (
          <EmptyState testID="newApp.startersEmpty" layout="centered" scene="noPlugins" title={t('capabilities.store.emptyTitle')} />
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
              <View style={dialog ? styles.dialogInset : null}>
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
                <View style={dialog ? styles.dialogInset : null}>
                  <SelectionTiles
                    density="compact"
                    maximumColumns={phone ? 1 : 3}
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
            title={t('newApp.codeLivesIn')}
            showChevron={false}
            subtitle={
              owner.kind === 'ready'
                ? `${owner.owner}/${repositoryName || '…'} · ${t('newApp.privateRepository')}`
                : owner.kind === 'loading'
                  ? '—'
                  : owner.kind === 'needsAccount'
                    ? t('newApp.githubNeeded')
                    : t('newApp.unavailable')
            }
            subtitleLines={0}
            icon={
              <Icon
                name="github-logo"
                size={ICON_SIZE.sm}
                color={theme.colors.text.secondary}
              />
            }
            rightElement={
              owner.kind === 'needsAccount' ? (
                <RoundButton
                  testID="newApp.connectGithub"
                  size="small"
                  display="inverted"
                  title={t('newApp.connectGithub')}
                  onPress={connectGithub}
                />
              ) : owner.kind === 'unavailable' && machine ? (
                <RoundButton
                  testID="newApp.recheckGithub"
                  size="small"
                  display="inverted"
                  title={t('newApp.retry')}
                  onPress={probeOwner}
                />
              ) : undefined
            }
          />
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
            title: headingTitle,
            subtitle: headingDescription,
            actions: <WizardStepDots currentStepIndex={stepIndex} stepCount={STEPS.length} />,
            footer: (
              <ModalCardFooterActions note={footerNote}
                noteAction={step === 'start' && !addingMachine ? { label: t('newApp.askAgent'), onPress: () => askAgentRef.current(), testID: 'newApp.askAgent' } : null}>
                {step === 'start' && !addingMachine ? (
                  <RoundButton
                    testID="newApp.cancel"
                    size="small"
                    display="inverted"
                    title={t('common.cancel')}
                    onPress={() => closeRef.current()}
                  />
                ) : null}
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
      primary?.testID,
      primary?.title,
      step,
      showBack,
      addingMachine,
      stepIndex,
      headingTitle,
      headingDescription,
    ],
  );
  useModalCardChrome(props.setChrome, dialogChrome);

  return (
    <View testID="newApp" style={styles.root}>
      <PluginSurfaceProjectionDemand accountScope={scope} presents="allInstallations" enabled={step === 'start'} />
      <ItemList testID="newApp.body" style={styles.list}>
        {body}
      </ItemList>
      {dialog || !primary ? null : (
        <KeyboardStickyFooter>
          {/* On a wide page the bar's contents stand on the page's content column (QA #35), not across the pane. */}
          <PagePinnedBar style={phone ? styles.phoneFooter : [styles.wideFooter, { maxWidth: pageMaxWidth }]}>
            {step === 'start' && !addingMachine ? (
              <TextLinkButton testID="newApp.askAgent" size="meta" label={t('newApp.askAgent')} onPress={askAgent} />
            ) : footerNote ? (
              <Text
                variant="meta"
                numberOfLines={1}
                style={{ color: theme.colors.text.secondary }}
              >
                {footerNote}
              </Text>
            ) : null}
            <RoundButton
              testID={primary.testID}
              size="normal"
              title={primary.title}
              disabled={primary.disabled}
              onPress={primary.onPress}
            />
          </PagePinnedBar>
        </KeyboardStickyFooter>
      )}
    </View>
  );
});

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
  // takes that step back so it shares the edge of the sheets beneath it. The start step's titled sections take it
  // twice: once around the group (its title lines up with the page title), once around tiles that have no sheet, so
  // they line up with the title and the run-existing row (measured live on #136: 416 → 432 against a 434 title).
  dialogInset: { paddingHorizontal: theme.space.s16 },

  phoneFooter: { gap: theme.space.s8 },
  wideFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.s12,
    width: '100%', marginHorizontal: 'auto' },
}));

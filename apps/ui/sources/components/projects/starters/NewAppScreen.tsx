import * as React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getBundledProjectStartersV1 } from '@happier-dev/protocol/projects/starters/bundledProjectStartersV1';
import type { ProjectStarterV1 } from '@happier-dev/protocol/projects/starters/projectStarterV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
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
import { Text } from '@/components/ui/text/Text';
import { WizardStepDots } from '@/components/onboarding/ui/WizardStepDots';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { resolveMachineKindGlyph } from '@/components/machines/machineKindGlyph';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import { randomUUID } from '@/platform/randomUUID';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
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
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { useDeviceType } from '@/utils/platform/responsive';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';

import {
  buildStarterCreateInput,
  createStarterIntentKeys,
  deriveRepositoryName,
  readStarterCreateOutcome,
  type StarterCreateOutcome,
} from './newAppDraft';
import { PROJECT_STARTER_PREVIEW_ASSETS } from './projectStarterPreviewAssets';
import { projectCheckoutParentPath } from '../activation/projectOpenChoices';

type Step = 'start' | 'describe' | 'create';
const STEPS: readonly Step[] = ['start', 'describe', 'create'];
/** Starter artwork is drawn 640 × 360; the tile shows its upper band (lab s1 preview strip). */
const STARTER_PREVIEW_ASPECT_RATIO = 3.2;
/** expo-image is not a Unistyles host, so its frame is a plain style. */
const PREVIEW_FILL = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;

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
    /** The ways to bring code you already have; offered when the entry that opened New app has them. */
    onClone?: (() => void) | null;
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
  const starters = getBundledProjectStartersV1();

  const [step, setStep] = React.useState<Step>('start');
  const [starterId, setStarterId] = React.useState<string | null>(
    starters.length === 1 ? starters[0]!.id : null,
  );
  const [description, setDescription] = React.useState('');
  const [name, setName] = React.useState('');
  const [machineId, setMachineId] = React.useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);
  const [owner, setOwner] = React.useState<OwnerFact>({ kind: 'loading' });
  const [create, setCreate] = React.useState<CreateState | null>(null);
  // One create intent per reviewed draft: a retry of the same review reuses it, so nothing is created twice.
  const [intentKeyFor] = React.useState(() => createStarterIntentKeys(randomUUID));

  const starter =
    starters.find((candidate) => candidate.id === starterId) ?? null;
  const machineNames = React.useMemo(
    () => resolveMachineDisplayNames(machines),
    [machines],
  );
  const effectiveMachineId =
    machineId ??
    (machines.some((candidate) => candidate.id === thisComputerMachineId)
      ? thisComputerMachineId
      : (machines[0]?.id ?? null));
  const machine =
    machines.find((candidate) => candidate.id === effectiveMachineId) ?? null;
  const homeDir = readMachineHomeDir(machine);
  const machineName = machine ? (machineNames.get(machine.id) ?? null) : null;

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

  const close = React.useCallback(() => {
    if (props.onClose) props.onClose();
    else safeRouterBack(router, '/projects');
  }, [props.onClose, router]);

  const connectGithub = React.useCallback(() => {
    close();
    router.push({
      pathname: '/(app)/settings/connected-services/[serviceId]',
      params: { serviceId: 'github' },
    } as never);
  }, [close, router]);
  const addComputer = React.useCallback(() => {
    close();
    router.push('/machines/add' as never);
  }, [close, router]);

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

  const submit = React.useCallback(async () => {
    if (!input || !scope) return;
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
        await execute(CREATE_ACTION, input, { confirmed: true }),
      );
    } catch (error) {
      const code =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : 'starter_create_failed';
      outcome =
        code === 'scm_account_required'
          ? { kind: 'needsScmAccount' }
          : {
              kind: 'failed',
              phase: null,
              code,
              repositoryCreated: false,
              remediation: null,
            };
    }
    setCreate(outcome);
    if (outcome.kind === 'needsScmAccount') {
      setOwner({ kind: 'needsAccount' });
      setStep('describe');
      return;
    }
    if (outcome.kind === 'created') {
      if (await startSession(outcome)) close();
      else setCreate({ kind: 'projectReady', created: outcome });
    }
  }, [close, input, scope, startSession]);

  const back = React.useCallback(() => {
    if (step === 'describe') setStep('start');
    else if (
      step === 'create' &&
      (create?.kind === 'failed' || create?.kind === 'outcomeUnknown')
    )
      setStep('describe');
    else close();
  }, [close, create?.kind, step]);
  const pageBack = usePageBackControl('newApp.back', back);

  const stepIndex = STEPS.indexOf(step);
  const primary =
    step === 'start'
      ? {
          title: t('common.continue'),
          disabled: !starter,
          onPress: () => setStep('describe'),
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
                  if (ok) close();
                });
              },
              testID: 'newApp.startBuilding',
            }
        : create?.kind === 'failed' || create?.kind === 'outcomeUnknown'
          ? {
              title: t('newApp.retry'),
              disabled: !input,
              onPress: () => {
                void submit();
              },
              testID: 'newApp.retry',
            }
          : null;
  const footerNote =
    step === 'start' && !starter
      ? t('newApp.startPick')
      : step === 'describe'
        ? t('newApp.reviewNote')
        : null;
  const showBack =
    step === 'describe' ||
    (step === 'create' && (create?.kind === 'failed' || create?.kind === 'outcomeUnknown'));
  const primaryRef = React.useRef(primary);
  primaryRef.current = primary;
  const backRef = React.useRef(back);
  backRef.current = back;

  const dialogChrome = React.useMemo(
    () =>
      dialog
        ? {
            kind: 'card' as const,
            footer: (
              <ModalCardFooterActions note={footerNote}>
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
    ],
  );
  useModalCardChrome(props.setChrome, dialogChrome);

  const header = (title: string, descriptionText: string) => (
    <NavigationBackChromeProvider control={dialog ? null : pageBack}>
      <PageHeader title={title} description={descriptionText} alwaysShowTitle />
    </NavigationBackChromeProvider>
  );

  const machineItems = React.useMemo(
    () =>
      machines.map((candidate) => ({
        id: candidate.id,
        title: machineNames.get(candidate.id) ?? candidate.id,
        checked: candidate.id === effectiveMachineId,
        icon: (
          <Icon
            name={resolveMachineKindGlyph({
              isThisComputer: candidate.id === thisComputerMachineId,
              platform: candidate.metadata?.platform,
            })}
            size={ICON_SIZE.sm}
            color={theme.colors.text.secondary}
          />
        ),
      })),
    [
      effectiveMachineId,
      machineNames,
      machines,
      theme.colors.text.secondary,
      thisComputerMachineId,
    ],
  );

  let body: React.ReactNode;
  if (step === 'start') {
    body = (
      <>
        {header(t('newApp.startTitle'), t('newApp.startDescription'))}
        <ItemGroup surface="none">
          <View style={dialog ? styles.dialogInset : null}>
            <SelectionTiles
              testIdPrefix="newApp.starter"
              variant="visual"
              tileSizing="fill"
              maximumColumns={3}
              previewAspectRatio={STARTER_PREVIEW_ASPECT_RATIO}
              accessibilityLabel={t('newApp.startTitle')}
              value={starterId}
              onChange={(next) => setStarterId(next)}
              labelLines={3}
              options={starters.map((candidate) => starterTile(candidate))}
            />
          </View>
        </ItemGroup>
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
                close();
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
            <DropdownMenu
              testID="newApp.machineMenu"
              open={machineMenuOpen}
              onOpenChange={setMachineMenuOpen}
              items={machineItems}
              onSelect={(id) => {
                setMachineMenuOpen(false);
                setMachineId(id);
              }}
              placement="bottom"
              trigger={({ toggle }) => (
                <Item
                  testID="newApp.machine"
                  title={t('newApp.builtBy')}
                  // A phone keeps only the chevron beside the label; the Machine joins its folder beneath.
                  detail={phone ? undefined : (machineName ?? undefined)}
                  subtitle={[
                    phone ? machineName : null,
                    homeDir && repositoryName
                      ? formatPathRelativeToHome(`${projectCheckoutParentPath(homeDir)}/${repositoryName}`, homeDir)
                      : null,
                  ].filter(Boolean).join(' · ') || undefined}
                  onPress={toggle}
                />
              )}
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
                  detail={starter.technologyLabels.join(' · ')}
                />
              )}
            >
              <View>
                <Item
                  mode="info"
                  title={t('newApp.detailStarter')}
                  detail={t(starter.titleKey as never)}
                  showChevron={false}
                />
                <Item
                  mode="info"
                  title={t('newApp.detailBuiltWith')}
                  detail={starter.technologyLabels.join(' · ')}
                  showChevron={false}
                />
                <Item
                  mode="info"
                  title={t('newApp.detailRevision')}
                  detail={starter.repository.ref.slice(0, 7)}
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

  return (
    <View testID="newApp" style={styles.root}>
      {dialog ? (
        <View style={styles.dots}>
          <WizardStepDots
            currentStepIndex={stepIndex}
            stepCount={STEPS.length}
          />
        </View>
      ) : null}
      <ItemList testID="newApp.body" style={styles.list}>
        {body}
      </ItemList>
      {dialog || !primary ? null : (
        <KeyboardStickyFooter>
          <PagePinnedBar style={styles.phoneFooter}>
            {footerNote ? (
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

function starterTile(starter: ProjectStarterV1) {
  const preview = PROJECT_STARTER_PREVIEW_ASSETS[starter.previewAssetKey];
  return {
    id: starter.id,
    title: t(starter.titleKey as never),
    subtitle: t(starter.summaryKey as never),
    preview: preview ? (
      <Image
        source={preview}
        style={PREVIEW_FILL}
        contentFit="cover"
        accessibilityIgnoresInvertColors
      />
    ) : undefined,
  };
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  list: { flex: 1 },
  dots: { paddingTop: theme.space.s4, paddingBottom: theme.space.s8 },
  haveCode: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s4,
  },
  // The card has no page gutter; inline sections take the sheet's inset there.
  dialogInset: { paddingHorizontal: theme.space.s16 },

  phoneFooter: { gap: theme.space.s8 },
}));

import * as React from 'react';
import type { DeploymentEnvironmentTabV1 } from '@happier-dev/deployments';
import { DeploymentPartialProgress } from './DeploymentPartialProgress';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentEnvironmentCopyChoicesV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentCopyV1';
import type { EnvironmentSecretBindingV1, EnvironmentSecretBindingIdentityV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ProjectRefSelect } from '@/components/projects/ProjectRefSelect';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { SelectionTiles, type SelectionTile } from '@/components/ui/forms/SelectionTiles';
import { PluginMark } from '@/components/settings/plugins/PluginMark';
import { PLUGINS_APP_ROUTE } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Switch } from '@/components/ui/forms/Switch';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useMachineListForServer } from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { presentSavedSecretReferencePicker } from '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker';
import { deploymentActionRefusalRemedy, deploymentDefinitionLabel } from './deploymentPresentation';

import type { createDeploymentActions } from './deploymentActions';
import { renderDeploymentCreationDefaultsRows } from './DeploymentCreationDefaultsRows';
import { useDeployHostReadiness } from './EnvironmentMachineChoice';
import { MachineSetupPlanReview } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useDeploymentPlatformTargets } from './DeploymentPlatformTargetSheet';
import type { readDeploymentPlatformTargets } from './platformTargetLink';
import {
  DeploymentRetentionChoice,
  deploymentManagedRetention,
  type DeploymentRetentionChoiceValue,
} from './DeploymentRetentionChoice';
import {
  readDeploymentActionError,
  deploymentPartialRecoveryTab,
  type DeploymentActionOutcome,
} from './deploymentActionOutcome';

type Actions = ReturnType<typeof createDeploymentActions>;
type PreparedCreate = Pick<Awaited<ReturnType<Actions['prepareCreate']>>, 'review' | 'run'>;
const DEFAULT_COMPOSE_PATH = 'compose.yaml';
const MACHINE_TILE = 'machine';
/** Not a choice: leads to Plugins, or reads the declared platforms again. */
const PLUGINS_TILE = 'plugins';
const RETRY_TILE = 'retry';
const LOADING_TILE = 'loading';

/**
 * A new Environment (lab d1 `draft`): its name, the Machine that runs it, what runs and who may deploy. It is
 * the selected draft row's detail; nothing exists until Save, and nothing is deployed until the person
 * chooses to. Save prepares the Environment through its Action and shows what the creation defaults filled in;
 * Create commits that same prepared run, and Back drops it.
 */
export const DeploymentEnvironmentDraft = React.memo(
  function DeploymentEnvironmentDraft(
    props: Readonly<{
      lifetime: ServerAccountScopeLifetime | null;
      sourceId: string;
      phone: boolean;
      actions: Pick<Actions, 'prepareCreate'> | null;
      copyFrom?: DeploymentEnvironmentDetailV1 | null;
      onApprovalRequested: (artifactId: string) => void;
      /** `platformTargetKey`: the new Environment runs on this platform, so its link sheet opens on it next. */
      onSaved: (environmentId: string, next?: Readonly<{ platformTargetKey?: string; tab?: DeploymentEnvironmentTabV1 }>) => void;
      /** Whether this viewer can link a platform; without it the draft offers machines only. */
      platformAvailable?: boolean;
      onDiscard: () => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const source =
      useProjectSource(props.lifetime, props.sourceId).source?.source ?? null;
    const allMachines = useMachineListForServer(
      props.lifetime?.scope.serverId ?? '', props.lifetime?.isCurrent() === true,
    );
    // A target link names each Machine's installation; a Machine without one cannot be linked.
    const machines = React.useMemo(
      () => (allMachines ?? []).filter((machine) => Boolean(machine.installationId)),
      [allMachines],
    );
    const [name, setName] = React.useState(() => props.copyFrom
      ? t('projects.deployments.copy.name', { name: props.copyFrom.content.name }) : '');
    const [copyChoices, setCopyChoices] = React.useState(() => props.copyFrom ? initialCopyChoices(props.copyFrom) : null);
    // A copy starts on the Machine its source runs on; the person can choose another.
    const [machineId, setMachineId] = React.useState<string | null>(() => props.copyFrom ? copySourceMachineId(props.copyFrom) : null);
    const router = useRouter();
    // Create takes a machine as its first target; a platform is linked on the new Environment right after.
    const platforms = useDeploymentPlatformTargets(props.platformAvailable === true ? props.lifetime : null);
    const platformTargets = platforms.state.status === 'ready' ? platforms.state.targets : NO_PLATFORM_TARGETS;
    const [targetKey, setTargetKey] = React.useState<string>(MACHINE_TILE);
    const platformTarget = props.platformAvailable === true ? platformTargets.find((target) => target.key === targetKey) ?? null : null;
    const onPlatform = platformTarget !== null;
    const [composePath, setComposePath] = React.useState(DEFAULT_COMPOSE_PATH);
    const [ref, setRef] = React.useState<string | null>(null);
    const [production, setProduction] = React.useState(props.copyFrom?.environment.protection === 'production');
    const [saving, setSaving] = React.useState(false);
    const [prepared, setPrepared] = React.useState<PreparedCreate | null>(null);
    const [refusal, setRefusal] =
      React.useState<DeploymentActionOutcome | null>(null);
    const partial = refusal?.kind === 'refused' ? refusal.progress : undefined;
    const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);
    const [retention, setRetention] =
      React.useState<DeploymentRetentionChoiceValue>('alwaysOn');
    const draftTitle = useCollectionDraftTitle();
    React.useEffect(() => {
      draftTitle.publish(name);
    }, [draftTitle, name]);
    React.useEffect(() => () => draftTitle.publish(''), [draftTitle]);

    // The first Machine that answers is the likely home; the person can choose another.
    const chosen =
      machines.find((machine) => machine.id === machineId) ??
      machines.find((machine) => isMachineOnline(machine)) ??
      machines[0] ??
      null;
    const branch = ref ?? source?.defaultRef ?? null;
    // A Compose Environment runs on the chosen Machine: its Docker host setup is planned once per choice, and a
    // Machine that needs it shows the setup review in place. Saving can wait for it; nothing runs until Apply.
    const host = useDeployHostReadiness(onPlatform ? null : props.lifetime, onPlatform ? null : chosen?.id ?? null);
    const [hostApply, setHostApply] = React.useState<Readonly<{ pending: boolean; error: string | null }>>(HOST_APPLY_IDLE);
    React.useEffect(() => setHostApply(HOST_APPLY_IDLE), [chosen?.id]);
    const applyHostSetup = async () => {
      const lifetime = props.lifetime;
      if (!host.prepared?.ok || !lifetime || hostApply.pending) return;
      setHostApply({ pending: true, error: null });
      let result;
      try {
        result = await hostSetupExecute.confirmed('machines.setup.apply', host.prepared.input, { surface: 'ui',
          serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId });
      } catch {
        setHostApply({ pending: false, error: 'managed_request_failed' });
        return;
      }
      const outcome = classifyHomeActionOutcome(result);
      if (outcome.kind === 'failed') { setHostApply({ pending: false, error: homeDomainFailureCode(outcome.failure) }); return; }
      setHostApply(HOST_APPLY_IDLE);
      if (outcome.kind === 'approval_pending') { props.onApprovalRequested(outcome.artifactId); return; }
      const output = ManagedMachineActionOutputSchemasV1['machines.setup.apply'].safeParse(outcome.result);
      if (output.success) openActionOperationDetail({ serverId: lifetime.scope.serverId, operationId: output.data.operationId });
    };
    const valid =
      name.trim().length > 0 &&
      chosen !== null &&
      (props.copyFrom !== undefined && props.copyFrom !== null || branch !== null &&
      (onPlatform || composePath.trim().length > 0));
    const { actions, onSaved, onApprovalRequested } = props;
    // A retention choice belongs to the Machine it was made for.
    React.useEffect(() => {
      setRetention('alwaysOn');
    }, [chosen?.id]);
    // A prepared run carries the exact operands it was prepared from; any edit makes it stale.
    React.useEffect(() => {
      setPrepared(null);
    }, [name, chosen?.id, branch, composePath, production, retention, onPlatform, copyChoices]);
    const machineName = (machineId: string) => {
      const machine = (allMachines ?? []).find((entry) => entry.id === machineId);
      return machine ? getMachineDisplayName(machine, allMachines ?? []) : t('approvals.machineNotKnown');
    };

    // Save is explicit creation intent; the host prepares omitted defaults and
    // retains the exact operands. Create runs that retained invocation, never a second preparation.
    const save = async () => {
      if (partial) {
        if (partial.environmentId) onSaved(partial.environmentId, { tab: deploymentPartialRecoveryTab(partial) });
        return;
      }
      if (!actions || !chosen?.installationId || (!props.copyFrom && !branch) || saving) return;
      setSaving(true);
      setRefusal(null);
      try {
        if (!prepared) {
          const next = await actions.prepareCreate({
            name: name.trim(),
            // A platform builds from the repository itself; only a Machine runs a Compose file.
            ...(props.copyFrom && copyChoices ? { copyFrom: {
              environmentId: props.copyFrom.environment.id, expectedRevision: props.copyFrom.environment.revision,
              choices: copyChoices,
            } } : { definition: onPlatform ? { from: 'repository', ref: branch! } : {
              from: 'repository', ref: branch!,
              compose: { path: composePath.trim(), profiles: [], services: [] },
            } }),
            protection: production ? 'production' : 'nonProduction',
            purpose: 'standard',
            deployerMode: props.copyFrom?.environment.deployerMode ?? 'managers',
            ...(props.copyFrom?.environment.deployerPrincipals === undefined ? {} : {
              deployerPrincipals: props.copyFrom.environment.deployerPrincipals,
            }),
            // A platform Environment still deploys from a Machine: the chosen one is its controller.
            ...(onPlatform ? { controllerMachineId: chosen.id } : {
              firstTargetLink: { machines: [{ machineId: chosen.id, installationId: chosen.installationId }] },
              ...deploymentManagedRetention(retention),
            }),
          });
          setPrepared({ review: next.review, run: next.run });
          return;
        }
        const created = await prepared.run();
        if (!created.ok) {
          setRefusal({ kind: 'refused', reason: 'other', code: created.error });
          return;
        }
        onSaved(created.environmentId, platformTarget ? { platformTargetKey: platformTarget.key } : undefined);
      } catch (error) {
        const outcome = readDeploymentActionError(error);
        if (outcome.kind === 'approval')
          onApprovalRequested(outcome.artifactId);
        setRefusal(outcome);
      } finally {
        setSaving(false);
      }
    };

    const platformStatus = platforms.state.status;
    const targetTiles = React.useMemo((): Array<SelectionTile<string>> => [
      { id: MACHINE_TILE, icon: 'hard-drives', title: t('projects.deployments.platformLink.onMachine'),
        subtitle: t('projects.deployments.whereDescription') },
      ...platformTargets.map((target): SelectionTile<string> => ({
        id: target.key, title: target.title, mark: <PluginMark title={target.title} pluginId={target.pluginId} />,
        ...(target.description ? { subtitle: target.description } : {}),
      })),
      // The tiles keep their place while the read answers; each other state says itself once, with its next step.
      ...(platformStatus === 'loading'
        ? [{ id: LOADING_TILE, icon: 'cube', title: t('projects.deployments.platformLink.loading'), disabled: true } satisfies SelectionTile<string>]
        : platformStatus === 'failed'
          ? [{ id: RETRY_TILE, icon: 'cube', title: t('projects.deployments.platformLink.failed'), subtitle: t('common.retry') } satisfies SelectionTile<string>]
          : platformTargets.length === 0
            ? [{ id: PLUGINS_TILE, icon: 'cube', title: t('projects.deployments.platformLink.usePlatform'),
                subtitle: t('projects.deployments.platformLink.emptyBody') } satisfies SelectionTile<string>]
            : []),
    ], [platformStatus, platformTargets]);
    const chooseTarget = (next: string | null) => {
      if (next === null || next === LOADING_TILE) return;
      if (next === PLUGINS_TILE) { router.push(PLUGINS_APP_ROUTE); return; }
      if (next === RETRY_TILE) { platforms.retry(); return; }
      setTargetKey(next);
    };
    const machineItems = React.useMemo(
      (): DropdownMenuItem[] =>
        machines.map((machine) => ({
          id: machine.id,
          title: getMachineDisplayName(machine, machines),
          subtitle: isMachineOnline(machine)
            ? undefined
            : t('projects.deployments.machineAway'),
          checked: machine.id === chosen?.id,
        })),
      [chosen?.id, machines],
    );

    const saveAction = {
      title: partial
        ? t('projects.deployments.openEnvironment')
        : prepared
        ? t('projects.deployments.creationReview.create')
        : t('projects.deployments.saveEnvironment'),
      onPress: () => {
        void save();
      },
      disabled: partial ? !partial.environmentId || saving : !valid || !actions || saving,
      loading: saving,
      testID: 'project-deployments.draft.save',
    };

    return (
      <View style={styles.page}>
        <ItemList testID="project-deployments.draft">
          <PageHeader
            testID="project-deployments.draft.header"
            title={name.trim() || t('projects.deployments.newEnvironment')}
            alwaysShowTitle
            leading={
              <PageHeaderMarkIcon name="plus" />
            }
            titleEditor={partial ? undefined : {
              value: name,
              placeholder: t('projects.deployments.namePlaceholder'),
              accessibilityLabel: t('projects.deployments.name'),
              onChangeText: setName,
              onCommit: () => setName((current) => current.trim()),
            }}
            description={t(partial ? 'projects.deployments.partialProgressBody' : props.copyFrom ? 'projects.deployments.copy.description' : 'projects.deployments.draftDescription')}
            {...(props.phone ? {} : { primaryAction: saveAction })}
            cancelAction={partial ? {
              title: t('common.close'), onPress: props.onDiscard, testID: 'project-deployments.draft.close',
            } : prepared ? {
              title: t('common.back'),
              onPress: () => setPrepared(null),
              testID: 'project-deployments.draft.back',
            } : {
              title: t('common.discard'),
              onPress: props.onDiscard,
              testID: 'project-deployments.draft.discard',
            }}
          />
          {partial && refusal?.kind === 'refused' && refusal.failure ? (
            <DeploymentPartialProgress testID="project-deployments.draft.progress" progress={partial} failure={refusal.failure} />
          ) : <>
          {refusal && refusal.kind === 'approval' ? (
            <AttentionBanner
              testID="project-deployments.draft.approval"
              tone="neutral"
              title={t('projects.deployments.createApprovalTitle')}
              description={t('projects.deployments.createApprovalBody')}
            />
          ) : refusal && refusal.kind === 'refused' ? (
            <AttentionBanner
              testID="project-deployments.draft.refused"
              tone="danger"
              title={t('projects.deployments.createFailedTitle')}
              description={deploymentActionRefusalRemedy(refusal.code)}
              details={[refusal.code]}
            />
          ) : null}
          {prepared ? (
            <ItemGroup
              testID="project-deployments.draft.defaults"
              title={t('projects.deployments.creationReview.title')}
              description={t('projects.deployments.creationReview.description')}
            >
              {renderDeploymentCreationDefaultsRows({
                defaults: prepared.review.creationDefaults,
                machineName,
                testID: 'project-deployments.draft.defaults',
              })}
            </ItemGroup>
          ) : null}
          <ItemGroup
            title={t('projects.deployments.whereTitle')}
            {...(!props.platformAvailable
              ? { description: t('projects.deployments.whereDescription') }
              : platformTarget
                ? { description: t('projects.deployments.platformLink.platformLater') }
                : {})}
          >
            {props.platformAvailable ? (
              <SelectionTiles<string>
                accessibilityLabel={t('projects.deployments.whereTitle')}
                testIdPrefix="project-deployments.draft.target"
                surface="sheet"
                subtitleLines={2}
                options={targetTiles}
                value={platformTarget?.key ?? MACHINE_TILE}
                onChange={chooseTarget}
                minimumColumns={1}
                maximumColumns={props.phone ? 1 : 3}
              />
            ) : null}
            {machines.length === 0 ? (
              <Item
                testID="project-deployments.draft.noMachine"
                title={t('projects.deployments.noMachineTitle')}
                subtitle={t('projects.deployments.noMachineBody')}
                mode="info"
              />
            ) : (
              <DropdownMenu
                testID="project-deployments.draft.machine"
                open={machineMenuOpen}
                onOpenChange={setMachineMenuOpen}
                items={machineItems}
                selectedId={chosen?.id ?? null}
                onSelect={(id) => {
                  setMachineMenuOpen(false);
                  setMachineId(id);
                }}
                itemTrigger={{
                  title: onPlatform
                    ? t('projects.deployments.platformLink.deploysFrom')
                    : t('projects.deployments.machine'),
                  showSelectedSubtitle: false,
                }}
              />
            )}
            {onPlatform ? null : (
              <DeploymentRetentionChoice
                testID="project-deployments.draft.retention"
                serverId={props.lifetime?.scope.serverId ?? null}
                machineId={chosen?.id ?? null}
                value={retention}
                onChange={setRetention}
              />
            )}
          </ItemGroup>
          {!onPlatform && chosen && host.readiness === 'needsSetup' && host.prepared?.ok ? <>
            <AttentionBanner
              testID="project-deployments.draft.hostSetup"
              tone="warning"
              title={t('projects.deployments.platformLink.hostNeedsSetup', { machine: machineName(chosen.id) })}
              description={t('projects.deployments.platformLink.hostSetupBody')}
              {...(hostApply.error ? { details: [hostApply.error] } : {})}
              action={{ label: t('projects.deployments.platformLink.hostSetupAction', { machine: machineName(chosen.id) }),
                onPress: () => { void applyHostSetup(); }, loading: hostApply.pending, disabled: hostApply.pending,
                display: 'secondary', testID: 'project-deployments.draft.hostSetup.apply' }}
            />
            <MachineSetupPlanReview testID="project-deployments.draft.hostSetup.review" prepared={host.prepared}
              nameOf={machineName} disabled={hostApply.pending} />
          </> : !onPlatform && chosen && host.readiness === 'unknown' && host.prepared?.ok ? (
            <ItemGroup>
              <Item testID="project-deployments.draft.hostUnchecked" mode="info"
                title={t('projects.deployments.platformLink.hostUnchecked', { machine: machineName(chosen.id) })} />
            </ItemGroup>
          ) : null}
          <ItemGroup
            title={t('projects.deployments.whatRunsTitle')}
            description={props.copyFrom ? undefined : onPlatform
              ? t('projects.deployments.platformLink.platformBuilds')
              : t('projects.deployments.whatRunsDescription')}
          >
            {props.copyFrom ? <Item title={deploymentDefinitionLabel(props.copyFrom.content) ?? t('projects.deployments.whatRunsTitle')}
              subtitle={props.copyFrom.content.name} mode="info" /> : <>
            {onPlatform ? null : <FieldValueItem
              testID="project-deployments.draft.compose"
              title={t('projects.deployments.composeFile')}
              value={composePath}
              placeholder={DEFAULT_COMPOSE_PATH}
              monospace
              autoCapitalize="none"
              autoComplete="off"
              onCommit={(text) => {
                setComposePath(text.trim());
                return text.trim();
              }}
            />}
            <ProjectRefSelect
              testID="project-deployments.draft.ref"
              title={t('projects.deployments.branch')}
              value={ref}
              defaultLabel={
                source?.defaultRef
                  ? t('projects.deployments.branchDefault', {
                      ref: source.defaultRef,
                    })
                  : t('projects.deployments.branchChoose')
              }
              compact={props.phone}
              onChange={setRef}
            />
            </>}
          </ItemGroup>
          {props.copyFrom && copyChoices ? (
            <ItemGroup title={t('projects.deployments.copy.bindings')} description={t('projects.deployments.copy.domainsStay')}>
              {copyChoices.secrets.map((choice, index) => {
                const identity = choice.binding;
                if (identity.purpose !== 'variable' && identity.purpose !== 'registry') return null;
                const title = identity.purpose === 'variable' ? identity.name : identity.registryOrigin;
                return <SegmentedChoiceItem<SecretCopyChoice> key={`secret:${index}`} title={title}
                  testIDPrefix={`project-deployments.draft.copy.secret:${index}`}
                  value={choice.kind === 'rebind' ? 'choose' : choice.kind}
                  options={[
                    { id: 'useSameReference', label: t('projects.deployments.copy.same') },
                    { id: 'choose', label: t('projects.deployments.copy.choose'), disabled: !props.lifetime },
                    { id: 'omit', label: t('projects.deployments.copy.omit') },
                  ]}
                  onChange={next => {
                    if (next !== 'choose') {
                      setCopyChoices(current => current ? { ...current, secrets: current.secrets.map((row, i) => i === index
                        ? { binding: row.binding, kind: next } : row) } : current);
                      return;
                    }
                    if (!props.lifetime) return;
                    // Choose another opens the one Saved Secret picker; dismissing it keeps the previous choice.
                    const lifetime = props.lifetime;
                    void presentSavedSecretReferencePicker({ accountLifetime: lifetime, signal: new AbortController().signal,
                      ...(choice.kind === 'rebind' ? { selected: { ref: choice.source.ref,
                        resourceRevision: choice.source.resourceRevision } } : {}),
                      isCurrent: lifetime.isCurrent }).then(selected => {
                      if (!selected) return;
                      setCopyChoices(current => current ? { ...current, secrets: current.secrets.map((row, i) => i === index
                        ? { binding: row.binding, kind: 'rebind', source: { kind: 'secret', ref: selected.ref,
                          resourceRevision: selected.resourceRevision } } : row) } : current);
                    });
                  }} />;
              })}
              {copyChoices.values.map((choice, index) => <Item key={`value:${index}`}
                title={choice.binding.purpose === 'variable' ? choice.binding.name : choice.binding.purpose}
                showChevron={false} subtitle={t('projects.deployments.copy.include')}
                rightElement={<Switch value={choice.kind !== 'omit'} onValueChange={include => setCopyChoices(current => current
                  ? { ...current, values: current.values.map((row, i) => i === index
                    ? { binding: row.binding, kind: include ? 'include' : 'omit' } : row) } : current)} />} />)}
            </ItemGroup>
          ) : null}
          {props.copyFrom && copyChoices && copyChoices.data.length > 0 ? (
            <ItemGroup title={t('projects.deployments.copy.dataTitle')}>
              {copyChoices.data.map((choice, index) => {
                const link = props.copyFrom?.targetLinks.find(row => row.targetLink.id === choice.targetLinkId);
                return <SegmentedChoiceItem<DataCopyChoice> key={choice.targetLinkId}
                  title={link?.targetLink.targetKind ?? choice.targetLinkId}
                  testIDPrefix={`project-deployments.draft.copy.data:${index}`}
                  value={choice.kind === 'omit' ? 'createEmpty' : choice.kind}
                  options={DATA_COPY_OPTIONS()}
                  onChange={next => setCopyChoices(current => current ? { ...current, data: current.data.map((row, i) => i === index
                    ? { targetLinkId: row.targetLinkId, kind: next } : row) } : current)} />;
              })}
            </ItemGroup>
          ) : null}
          <ItemGroup
            title={t('projects.deployments.whoTitle')}
            description={props.copyFrom ? undefined
              : `${t('projects.deployments.whoManagers')} · ${t('projects.deployments.whoDescription')}`}
          >
            <Item
              testID="project-deployments.draft.production"
              title={t('projects.deployments.production')}
              subtitle={t('projects.deployments.productionHint')}
              rightElement={
                <Switch value={production} onValueChange={setProduction} />
              }
              onPress={() => setProduction((current) => !current)}
              showChevron={false}
            />
          </ItemGroup>
          </>}
        </ItemList>
        {props.phone ? (
          <KeyboardStickyFooter>
            <PagePinnedBar>
              <RoundButton
                testID="project-deployments.draft.save.phone"
                title={saveAction.title}
                disabled={saveAction.disabled}
                loading={saving}
                onPress={saveAction.onPress}
              />
            </PagePinnedBar>
          </KeyboardStickyFooter>
        ) : null}
      </View>
    );
  },
);

type SecretCopyChoice = 'useSameReference' | 'choose' | 'omit';
type DataCopyChoice = Exclude<DeploymentEnvironmentCopyChoicesV1['data'][number]['kind'], 'omit'>;
/** A copy's data is a deliberate choice; each option says what the new Environment gets. */
const DATA_COPY_OPTIONS = (): ReadonlyArray<SegmentedChoiceOption<DataCopyChoice>> => [
  { id: 'reuse', label: t('projects.deployments.copy.dataReuse'), description: t('projects.deployments.copy.dataReuseHint') },
  { id: 'createEmpty', label: t('projects.deployments.copy.dataEmpty'), description: t('projects.deployments.copy.dataEmptyHint') },
  { id: 'restoreBackup', label: t('projects.deployments.copy.dataRestore'), description: t('projects.deployments.copy.dataRestoreHint') },
];

const HOST_APPLY_IDLE = Object.freeze({ pending: false, error: null });
const hostSetupExecute = createFrontDoorActionExecute();

const NO_PLATFORM_TARGETS: ReturnType<typeof readDeploymentPlatformTargets> = [];

function copyBindingIdentity({ source: _source, ...identity }: EnvironmentSecretBindingV1): EnvironmentSecretBindingIdentityV1 {
  if (identity.purpose === 'registry') {
    const { access: _access, ...registry } = identity;
    return registry;
  }
  return identity;
}

/** The source's runtime Machine, else its controller: where the copy is most likely meant to run. */
function copySourceMachineId(source: DeploymentEnvironmentDetailV1): string {
  return source.targetLinks.find((row) => row.targetLink.role === 'runtime')?.targetLink.machines[0] ?? source.environment.controllerMachineId;
}

/** Copy admission requires an explicit choice per source row; no values or credentials are opened here. */
function initialCopyChoices(source: DeploymentEnvironmentDetailV1): DeploymentEnvironmentCopyChoicesV1 {
  return {
    secrets: source.content.bindings.filter(row => row.source.kind === 'secret').map((row): DeploymentEnvironmentCopyChoicesV1['secrets'][number] => ({
      binding: copyBindingIdentity(row), kind: row.purpose === 'variable' || row.purpose === 'registry' ? 'useSameReference' : 'omit',
    })),
    values: source.content.bindings.filter(row => row.source.kind !== 'secret').map((row): DeploymentEnvironmentCopyChoicesV1['values'][number] => ({
      binding: copyBindingIdentity(row), kind: 'include',
    })),
    data: source.targetLinks.filter(row => row.targetLink.role === 'data').map(row => ({ targetLinkId: row.targetLink.id, kind: 'createEmpty' })),
    retainPreviousDeployments: 'copy',
  };
}

const styles = StyleSheet.create(() => ({
  page: { flex: 1, minHeight: 0 },
}));

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { MachineServiceRowV1 } from '@happier-dev/protocol';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildDeploymentEnvironmentHref } from '@/components/projects/deployments/deploymentNavigation';
import {
  DeploymentProjectChoiceGroups,
  useDeploymentProjectChoice,
} from '@/components/projects/deployments/DeploymentProjectChoice';
import { MachineSetupReviewFooter } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { presentSavedSecretReferencePicker } from '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { environmentSecretBindingIdentityV1, type EnvironmentVariableBindingV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { machineServiceAdoptionMissing } from './machineServiceAdoptionPresentation';
import { useMachineServiceAdoption, type MachineServiceAdoption } from './useMachineServiceAdoption';

type Props = Readonly<{
  serverId: string;
  machineId: string;
  machineName: string;
  service: MachineServiceRowV1;
  onClose: () => void;
  /** The Action front door; tests build one over the real executor. */
  execute?: FrontDoorActionExecute;
}>;

/** Adopt a watched Compose project (lab `machine/services/adoptSheet`, phone `adoptp`), over its service page. */
export function showMachineServiceAdoption(props: Omit<Props, 'onClose'>) {
  Modal.show({ component: MachineServiceAdoptionModal, props });
}

function MachineServiceAdoptionModal(props: Omit<Props, 'onClose'> & CustomModalInjectedProps) {
  return <MachineServiceAdoptionReview {...props} />;
}

type Review = Extract<MachineServiceAdoption, { review: unknown }>['review'];
type Variable = NonNullable<Review>['variables'][number];

/**
 * What adopting does, in the person's words, before anything changes: what Happier stores (read from the project's
 * Compose configuration, without values), what it keeps (name and volumes), that nothing restarts now and only this
 * watch retires, and that the first deploy hands it over. Then the choices it needs: the future profiles, a value or
 * saved secret for each captured variable, the Environment's name and its Project. One Adopt applies exactly that.
 */
export function MachineServiceAdoptionReview(props: Props & Partial<Pick<CustomModalInjectedProps, 'setChrome'>>) {
  const adoption = useMachineServiceAdoption({ serverId: props.serverId, machineId: props.machineId,
    service: props.service, ...(props.execute ? { execute: props.execute } : {}) });
  const { review } = adoption;
  // The capture is the sheet's first read: it starts once, when the sheet opens (and again for a new generation).
  const started = React.useRef<string | null>(null);
  const generation = props.service.generation;
  React.useEffect(() => {
    if (!adoption.lifetime || started.current === generation) return;
    started.current = generation;
    void review([]);
  }, [adoption.lifetime, generation, review]);
  const lifetime = adoption.lifetime;
  return lifetime
    ? <AdoptionBody {...props} adoption={adoption} lifetime={lifetime} />
    : <SurfaceStateCard testID="machine-service-adopt.reading" kind="loading" size="line"
      title={t('machineServices.adopt.reading', { service: props.service.name })} />;
}

function AdoptionBody(props: Props & Partial<Pick<CustomModalInjectedProps, 'setChrome'>> & Readonly<{
  adoption: ReturnType<typeof useMachineServiceAdoption>;
  lifetime: ServerAccountScopeLifetime;
}>) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { adoption, service, onClose } = props;
  const { state } = adoption;
  const currentReview: Review | null = 'review' in state ? state.review : null;
  const [environmentName, setEnvironmentName] = React.useState(service.name);
  const [production, setProduction] = React.useState(false);
  const project = useDeploymentProjectChoice({ lifetime: props.lifetime, initiallyNew: true, initialNewProjectName: service.name });
  // Bindings live in the Environment's own editor (the hook's), which owns their validation.
  const { bindings, bindingsEditor } = adoption;
  const unbound = currentReview ? machineServiceAdoptionMissing(currentReview.variables, bindings) : 0;
  const bindingOf = (variable: Variable) => bindings.find(binding => binding.name === variable.name && binding.phase === variable.phase);
  const bindVariable = (variable: Variable, source: EnvironmentVariableBindingV1['source'] | null) => {
    const existing = bindingOf(variable);
    const identity = existing ? environmentSecretBindingIdentityV1(existing) : undefined;
    if (source === null) { if (identity) bindingsEditor.remove(identity); return; }
    bindingsEditor.setVariable({ name: variable.name, phase: variable.phase, source, ...(identity ? { originalIdentity: identity } : {}) });
  };
  const missing = currentReview === null ? null
    : unbound > 0 ? t('machineServices.adopt.fillVariables')
      : !environmentName.trim() ? t('machineServices.adopt.nameEnvironment')
        : project.missing;
  const busy = state.kind === 'reading' || state.kind === 'applying';
  const adopt = () => {
    if (missing !== null || !project.selection || busy) return;
    fireAndForget(adoption.apply({
      destination: { name: environmentName.trim(), protection: production ? 'production' : 'nonProduction',
        purpose: 'standard', deployerMode: 'managers', ...project.selection },
      bindings,
    }), { tag: 'MachineServiceAdoption.apply' });
  };
  const openEnvironment = state.kind === 'adopted' && project.selection && 'projectSourceId' in project.selection
    ? buildDeploymentEnvironmentHref({ serverId: props.serverId, projectSourceId: project.selection.projectSourceId,
      environmentId: state.environmentId }) : null;
  const pickSecret = async (variable: Variable) => {
    const lifetime = props.lifetime;
    const controller = new AbortController();
    const selection = await presentSavedSecretReferencePicker({ accountLifetime: lifetime, signal: controller.signal,
      isCurrent: () => lifetime.isCurrent() });
    if (!selection) return;
    bindVariable(variable, { kind: 'secret', ref: selection.ref, resourceRevision: selection.resourceRevision });
  };

  const footer = state.kind === 'adopted' ? (
    <MachineSetupReviewFooter
      onCancel={onClose}
      cancelLabel={t('machineServices.adopt.done')}
      cancelTestID="machine-service-adopt.done"
      note={null}
      {...(openEnvironment ? { primary: { label: t('machineServices.adopt.openEnvironment'), testID: 'machine-service-adopt.open',
        onPress: () => {
          onClose();
          const result = runGuardedNavigation(() => router.push(openEnvironment as never));
          if (result !== true) fireAndForget(result, { tag: 'MachineServiceAdoption.open' });
        } } } : {})}
    />
  ) : (
    <MachineSetupReviewFooter
      onCancel={() => { adoption.abort(); onClose(); }}
      cancelTestID="machine-service-adopt.cancel"
      note={t('machineServices.adopt.note')}
      {...(state.kind === 'applying' && state.approval ? {} : { primary: state.kind === 'partial' ? {
        label: t('machineServices.adopt.retry'), testID: 'machine-service-adopt.retry',
        onPress: () => { fireAndForget(adoption.retry(), { tag: 'MachineServiceAdoption.retry' }); },
      } : {
        label: t('machineServices.adopt.confirm'), testID: 'machine-service-adopt.confirm',
        loading: state.kind === 'applying',
        disabled: busy || missing !== null || currentReview === null,
        ...(missing ? { accessibilityHint: missing } : {}),
        onPress: adopt,
      } })}
    />
  );
  const chrome = React.useMemo(() => ({
    kind: 'card' as const,
    title: t('machineServices.adopt.title', { service: service.name }),
    subtitle: t('machineServices.adopt.subtitle'),
    footer,
    phonePresentation: 'sheet' as const,
    scrollHost: 'body' as const,
    dimensions: { size: 'md' as const, maxHeightRatio: 0.88 },
  }), [footer, service.name]);
  useModalCardChrome(props.setChrome, chrome);

  const selectedProject = project.newProject ? null : project.sources.rows.find(row => row.id === project.sourceId) ?? null;
  const becomesProject = project.newProject
    ? t('machineServices.adopt.becomesNewProject', { project: project.newProjectName.trim() || service.name })
    : selectedProject ? t('machineServices.adopt.becomesProject', { project: selectedProject.name }) : undefined;
  const icon = (name: IconName) => <Icon name={name} size={ICON_SIZE.md} color={theme.colors.text.secondary} />;
  const body = state.kind === 'adopted' ? (
    <ItemGroup testID="machine-service-adopt.adopted">
      <Item mode="info" subtitleLines={0} icon={icon('check-circle')}
        title={t('machineServices.adopt.adoptedTitle', { service: service.name, environment: environmentName.trim() })}
        subtitle={t('machineServices.adopt.adoptedBody')} />
    </ItemGroup>
  ) : currentReview === null ? (
    state.kind === 'failed' ? (
      <SurfaceStateCard testID="machine-service-adopt.read-failed" kind="error" size="line"
        title={t('machineServices.adopt.readFailed', { service: service.name })}
        reason={failureReason(state.code, service.name, props.machineName)} diagnosticCode={state.code}
        action={{ label: t('machineServices.adopt.readAgain'), onPress: () => { void adoption.review([]); } }} />
    ) : (
      <SurfaceStateCard testID="machine-service-adopt.reading" kind="loading" size="line"
        title={t('machineServices.adopt.reading', { service: service.name })} />
    )
  ) : (
    <>
      <ItemGroup testID="machine-service-adopt.changes">
        <Item mode="info" subtitleLines={0} icon={icon('cube')} testID="machine-service-adopt.becomes"
          title={t('machineServices.adopt.becomes', { environment: environmentName.trim() || service.name })}
          subtitle={becomesProject} />
        <Item mode="info" subtitleLines={0} icon={icon('file-text')} title={t('machineServices.adopt.definition')}
          subtitle={t('machineServices.adopt.definitionDetail', { services: currentReview.services.join(', ') })} />
        <Item mode="info" subtitleLines={0} icon={icon('hard-drives')} title={t('machineServices.adopt.keeps')}
          subtitle={t('machineServices.adopt.keepsDetail')} />
        <Item mode="info" subtitleLines={0} icon={icon('play-circle')} title={t('machineServices.adopt.now')}
          subtitle={t('machineServices.adopt.nowDetail', { service: service.name })} />
        <Item mode="info" subtitleLines={0} icon={icon('rocket')} title={t('machineServices.adopt.firstDeploy')}
          subtitle={t('machineServices.adopt.firstDeployDetail')} />
      </ItemGroup>
      {/* A partial adoption continues with exactly what was applied: its choices are no longer editable here. */}
      {state.kind === 'partial' ? null : <>
      {currentReview.availableProfiles.length > 0 ? (
        <ItemGroup title={t('machineServices.adopt.profilesTitle')} description={t('machineServices.adopt.profilesDescription')}>
          {currentReview.availableProfiles.map(profile => {
            const on = currentReview.profiles.includes(profile);
            const toggle = () => {
              if (busy) return;
              const next = on ? currentReview.profiles.filter(entry => entry !== profile) : [...currentReview.profiles, profile];
              void adoption.review(next);
            };
            return (
              <Item key={profile} testID={`machine-service-adopt.profile.${profile}`} title={profile}
                rightElement={<Switch value={on} disabled={busy} onValueChange={toggle} />} onPress={toggle} showChevron={false} />
            );
          })}
        </ItemGroup>
      ) : null}
      <ItemGroup title={t('machineServices.adopt.variablesTitle')} description={t('machineServices.adopt.variablesDescription')}>
        {currentReview.variables.length === 0 ? (
          <SurfaceStateCard kind="empty" size="line" title={t('machineServices.adopt.variablesNone')} />
        ) : currentReview.variables.map(variable => {
          const value = bindingOf(variable)?.source;
          return (
            <Item
              key={`${variable.phase}:${variable.name}`}
              testID={`machine-service-adopt.variable.${variable.name}`}
              title={<Text style={Typography.mono()}>{variable.name}</Text>}
              subtitle={value?.kind === 'secret'
                ? t('machineServices.adopt.usesSecret', { secret: t('machineServices.adopt.savedSecret') })
                : variable.hasDefault ? t('machineServices.adopt.variableHasDefault') : t('machineServices.adopt.variableRequired')}
              accessoryLayout="adaptive"
              showChevron={false}
              rightElement={
                <View style={styles.valueRow}>
                  {value?.kind === 'secret' ? (
                    <IconButton testID={`machine-service-adopt.clear.${variable.name}`} iconName="x" variant="plain"
                      accessibilityLabel={t('machineServices.adopt.clearSecret')}
                      tooltip={t('machineServices.adopt.clearSecret')}
                      onPress={() => bindVariable(variable, null)} />
                  ) : (
                    <>
                      <View style={styles.valueField}>
                        <FieldTextInput
                          testID={`machine-service-adopt.value.${variable.name}`}
                          value={value?.kind === 'value' ? value.value : ''}
                          placeholder={t('machineServices.adopt.valuePlaceholder')}
                          accessibilityLabel={variable.name}
                          onChangeText={text => bindVariable(variable, text.length > 0 ? { kind: 'value', value: text } : null)}
                        />
                      </View>
                      <IconButton testID={`machine-service-adopt.secret.${variable.name}`} iconName="key" variant="plain"
                        accessibilityLabel={t('machineServices.adopt.useSecret')} tooltip={t('machineServices.adopt.useSecret')}
                        onPress={() => { void pickSecret(variable); }} />
                    </>
                  )}
                </View>
              }
            />
          );
        })}
      </ItemGroup>
      <ItemGroup title={t('machineServices.adopt.environmentTitle')} description={t('machineServices.adopt.environmentDescription')}>
        <Item
          title={t('projects.deployments.name')}
          accessoryLayout="adaptive"
          showChevron={false}
          rightElement={<View style={styles.valueField}><FieldTextInput testID="machine-service-adopt.name" value={environmentName}
            onChangeText={setEnvironmentName} accessibilityLabel={t('projects.deployments.name')} /></View>}
        />
        <Item testID="machine-service-adopt.production" title={t('projects.deployments.production')}
          subtitle={t('projects.deployments.productionHint')}
          rightElement={<Switch value={production} onValueChange={setProduction} />}
          onPress={() => setProduction(current => !current)} showChevron={false} />
      </ItemGroup>
      <DeploymentProjectChoiceGroups model={project} testIDPrefix="machine-service-adopt.project"
        description={t('machineServices.adopt.projectDescription')} newProjectHint={t('machineServices.adopt.projectNewHint')} />
      </>}
    </>
  );

  return (
    <ItemList presentation="grouped" keyboardShouldPersistTaps="handled">
      {state.kind === 'applying' && state.approval ? (
        <ActionApprovalPendingNotice testID="machine-service-adopt.approval" presentation="banner"
          message={t('machineServices.adopt.approval')}
          onOpenApproval={() => {
            const artifactId = state.approval!.artifactId;
            onClose();
            const result = runGuardedNavigation(() => router.push(buildApprovalHref(artifactId, props.serverId) as never));
            if (result !== true) fireAndForget(result, { tag: 'MachineServiceAdoption.approval' });
          }} />
      ) : null}
      {state.kind === 'partial' ? (
        <AttentionBanner testID="machine-service-adopt.partial" tone="warning" placement="inline"
          title={t('machineServices.adopt.partialTitle')} description={t('machineServices.adopt.partialBody', { service: service.name })}
          details={[state.errorCode]} />
      ) : null}
      {state.kind === 'failed' && state.step === 'apply' ? (
        <SurfaceStateCard testID="machine-service-adopt.failed" kind="error" size="line"
          title={t('machineServices.adopt.failedTitle', { service: service.name })}
          reason={failureReason(state.code, service.name, props.machineName)} diagnosticCode={state.code}
          {...(state.code === 'approval_stale' ? { action: { label: t('machineServices.adopt.readAgain'),
            onPress: () => { void adoption.review(state.review?.profiles ?? []); } } } : {})} />
      ) : null}
      {body}
      {props.setChrome ? null : footer}
    </ItemList>
  );
}

function failureReason(code: string, service: string, machine: string): string {
  switch (code) {
    case 'approval_stale': return t('machineServices.adopt.reason.changed', { service });
    case 'secret_binding_required': return t('machineServices.adopt.reason.variables');
    case 'unsupported_action':
    case 'service_admission_unavailable': return t('machineServices.adopt.reason.unsupported', { machine });
    default: return t('machineServices.adopt.reason.other', { service });
  }
}

const styles = StyleSheet.create((theme) => ({
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
  valueField: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
}));

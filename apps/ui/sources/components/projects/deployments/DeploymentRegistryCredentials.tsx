import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { EnvironmentSecretBindingV1Schema, environmentSecretBindingIdentityV1,
  type EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol/v1';
import { projectEnvironmentSecretBindingIdentityV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { presentSavedSecretReferencePicker } from '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { InlineFormActions } from '@/components/ui/forms/InlineAddExpander';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { t } from '@/text';
import { DeployOutcomeBanner } from './DeploymentEnvironmentDetail';
import type { DeploymentEnvironmentEditing } from './DeploymentEnvironmentSettingsPanel';
import { useDeploymentChangePress } from './deploymentActionOutcome';

type RegistryBinding = Extract<EnvironmentSecretBindingV1, { purpose: 'registry' }>;
const id = 'project-deployments.environment.settings.registry';
const noop = () => {};

/** The registry arm of the one Environment binding writer; no credential bytes enter this editor. */
export function DeploymentRegistryCredentials(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1; editing: DeploymentEnvironmentEditing | null;
  lifetime: ServerAccountScopeLifetime | null; machineName: (id: string) => string;
}>) {
  const bindings = props.detail.content.bindings.filter((binding): binding is RegistryBinding => binding.purpose === 'registry');
  const editing = props.editing;
  const setBindings = editing?.actions.setBindings;
  const change = useDeploymentChangePress(editing?.review ?? null, editing?.onChanged ?? noop);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = bindings.find(binding => environmentSecretBindingIdentityV1(binding) === selectedId) ?? bindings[0] ?? null;
  const [draft, setDraft] = React.useState<Readonly<{ original: RegistryBinding | null; targetLinkId: string;
    registryOrigin: string; access: RegistryBinding['access']; source: RegistryBinding['source'] | null }> | null>(null);
  const picker = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => picker.current?.abort(), []);
  const editable = Boolean(setBindings && props.lifetime);
  const open = (binding: RegistryBinding | null) => setDraft({ original: binding,
    targetLinkId: binding?.targetLinkId ?? props.detail.runtimeTargetLink?.id ?? '',
    registryOrigin: binding?.registryOrigin ?? '', access: binding?.access ?? 'pull', source: binding?.source ?? null });
  const candidate = draft?.source ? EnvironmentSecretBindingV1Schema.safeParse({ purpose: 'registry',
    targetLinkId: draft.targetLinkId, registryOrigin: draft.registryOrigin, access: draft.access, source: draft.source }) : null;
  const choose = async () => {
    if (!draft || !props.lifetime) return;
    picker.current?.abort();
    const controller = new AbortController(); picker.current = controller;
    const selection = await presentSavedSecretReferencePicker({ accountLifetime: props.lifetime,
      signal: controller.signal, selected: draft.source ? { ref: draft.source.ref, resourceRevision: draft.source.resourceRevision } : undefined,
      isCurrent: () => props.lifetime?.isCurrent() === true });
    if (selection) setDraft(current => current ? { ...current,
      source: { kind: 'secret', ref: selection.ref, resourceRevision: selection.resourceRevision } } : null);
  };
  const save = async () => {
    if (!setBindings || !draft || !candidate?.success) return;
    const previousIdentity = draft.original ? environmentSecretBindingIdentityV1(draft.original) : null;
    const success = await change.press(() => setBindings({ environmentId: props.detail.environment.id,
      expectedRevision: props.detail.environment.revision,
      remove: draft.original && previousIdentity !== environmentSecretBindingIdentityV1(candidate.data)
        ? [projectEnvironmentSecretBindingIdentityV1(draft.original)] : [],
      set: [candidate.data] }));
    if (success) setDraft(null);
  };
  const remove = () => {
    if (!setBindings || !selected) return;
    void change.press(() => setBindings({ environmentId: props.detail.environment.id,
      expectedRevision: props.detail.environment.revision, set: [], remove: [projectEnvironmentSecretBindingIdentityV1(selected)] }));
  };
  return <><ItemGroup testID={id} title={t('projects.deployments.settingsSections.registryTitle')}
    description={t('projects.deployments.settingsSections.registryBody')}
    action={editable && !draft && props.detail.runtimeTargetLink ? <SectionActionButton testID={`${id}.add`} icon="plus"
      title={t('common.add')} onPress={() => open(null)} disabled={change.running} /> : undefined}>
    {draft ? <>
      <Item title={t('projects.deployments.settingsSections.registryTarget')} accessoryLayout="adaptive"
        rightElement={<ValueFieldSelect testID={`${id}.target`} label={t('projects.deployments.settingsSections.registryTarget')}
          items={props.detail.targetLinks.map(({ targetLink }) => ({ id: targetLink.id, title: targetLink.targetKind }))}
          selectedId={draft.targetLinkId} disabled={change.running} onSelect={targetLinkId => setDraft({ ...draft, targetLinkId })} />} />
      <FieldValueItem title={t('projects.deployments.settingsSections.registryOrigin')} value={draft.registryOrigin}
        fieldTestID={`${id}.origin.input`} onDraftChange={registryOrigin => setDraft({ ...draft, registryOrigin })}
        onCommit={registryOrigin => { setDraft({ ...draft, registryOrigin }); }} disabled={change.running} />
      <SegmentedChoiceItem testID={`${id}.access`} testIDPrefix={`${id}.access`} title={t('projects.deployments.settingsSections.registryAccess')}
        value={draft.access} accessoryLayout="adaptive" disabled={change.running}
        options={[{ id: 'pull', label: t('projects.deployments.settingsSections.registryPull') },
          { id: 'pushPull', label: t('projects.deployments.settingsSections.registryPushPull') }]}
        onChange={access => setDraft({ ...draft, access })} />
      <Item title={t('projects.deployments.settingsSections.credentialChoose')}
        subtitle={draft.source ? t('projects.deployments.settingsSections.credentialSet') : t('projects.deployments.settingsSections.credentialMissing')}
        testID={`${id}.secret`} onPress={() => { void choose(); }} disabled={change.running} />
    </> : selected ? <>
      {bindings.length > 1 ? <Item title={t('projects.deployments.settingsSections.registryOrigin')} accessoryLayout="adaptive"
        rightElement={<ValueFieldSelect testID={`${id}.selection`} label={t('projects.deployments.settingsSections.registryOrigin')}
          items={bindings.map(binding => ({ id: environmentSecretBindingIdentityV1(binding), title: binding.registryOrigin }))}
          selectedId={environmentSecretBindingIdentityV1(selected)} onSelect={setSelectedId} />} /> : null}
      <Item title={selected.registryOrigin} subtitle={t(selected.access === 'pull'
        ? 'projects.deployments.settingsSections.registryPull' : 'projects.deployments.settingsSections.registryPushPull')}
        testID={`${id}.edit`} mode={editable ? undefined : 'info'} onPress={editable ? () => open(selected) : undefined} />
      {editable ? <Item testID={`${id}.remove`} title={t('common.remove')} onPress={remove} disabled={change.running} /> : null}
    </> : <Item title={t('projects.deployments.settingsSections.registryNone')} mode="info" />}
    {change.outcome && editing ? <DeployOutcomeBanner controller={change.banner}
      machine={props.machineName(props.detail.environment.controllerMachineId)} copy="setting" /> : null}
  </ItemGroup>
  {/* A form of sheet rows ends after its sheet: its one primary, then a quiet Cancel (R2-D15 ruling). */}
  {draft ? <ItemGroup surface="none"><InlineFormActions saveLabel={t('common.save')} cancelLabel={t('common.cancel')}
    onSave={() => { void save(); }} saveDisabled={change.running || candidate?.success !== true} saving={change.running}
    onCancel={() => setDraft(null)} saveTestID={`${id}.save`} cancelTestID={`${id}.cancel`} /></ItemGroup> : null}</>;
}

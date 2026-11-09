import * as React from 'react';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { MachineSetupSourceEntryV1, MachineSetupSourceV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { useUnistyles } from 'react-native-unistyles';

import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { createMachinePresetCollectionClient } from '@/components/settings/machines/managed/machinePresetCollectionClient';
import { describeMachineSetup, machineSetupItemReadRow } from '@/components/settings/machines/managed/MachineSetupSection';
import { MachineSetupReviewFooter } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { machineSetupItemPresentation } from '@/components/settings/machines/managed/machineSetupItems';
import { ManagedSectionCount } from '@/components/settings/machines/managed/ManagedSectionCount';
import { useSoftwareOptions } from '@/components/store/catalog/storeSoftware';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { machineSetupSourceName } from './machineSetupSourceName';
import { projectMachineSetupCapture, type MachineSetupCaptureInclude, type MachineSetupCaptureRow } from './machineSetupCapture';

export type MachineSavePresetProps = Readonly<{
  serverId: string;
  homeId: string;
  scope: ServerAccountScope;
  machineName: string;
  sources: MachineSetupSourceV1;
  presets: readonly ManagedMachinePresetV1[];
  /** The preset exists: the Machine has not changed. Opens its editor. */
  onSaved: (presetId: string) => void;
}>;

/** Lab `p/save`: copy what Happier set up here into a setup-only preset. Saving writes a preset and nothing else. */
export function showMachineSavePreset(props: MachineSavePresetProps) {
  return Modal.show({ component: MachineSavePresetModal, props });
}

const KIND_GROUPS = [
  { kind: 'setupRecipe', title: 'machinePresets.setup.tab.recipesSetup' },
  { kind: 'softwareRecipe', title: 'machinePresets.setup.tab.recipesSoftware' },
  { kind: 'app', title: 'machinePresets.setup.tab.recipesApps' },
] as const;

const NO_TICKS: ReadonlySet<string> = new Set();

function MachineSavePresetModal(props: MachineSavePresetProps & CustomModalInjectedProps) {
  const { onClose, onSaved, scope, homeId, machineName, presets, sources, serverId, setChrome } = props;
  const { theme } = useUnistyles();
  const [name, setName] = React.useState(() => t('machinePresets.setup.tab.captureNameDefault', { machine: machineName }));
  const [include, setInclude] = React.useState<MachineSetupCaptureInclude>('everything');
  const [unticked, setUnticked] = React.useState<ReadonlySet<string>>(NO_TICKS);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);

  const attached = sources.filter((source): source is Exclude<MachineSetupSourceEntryV1, { kind: 'direct' }> => source.kind !== 'direct');
  const nameOf = (source: MachineSetupSourceEntryV1) => source.kind === 'direct' ? t('machinePresets.setup.tab.captureAddedHere') : machineSetupSourceName(source, presets);
  const capture = React.useMemo(() => projectMachineSetupCapture(sources, include, unticked), [include, sources, unticked]);
  const recipes = capture.rows.some((row) => row.item.kind !== 'app');
  const target = React.useMemo(() => ({ scope, machine: null }), [scope]);
  const software = useSoftwareOptions(target, { presented: recipes });
  const offers = software.state.status === 'ready' ? software.state.options : null;

  const approval = useActionApprovalContinuation({ serverId, scopeKey: JSON.stringify([serverId, scope.accountId, 'machine-save-preset']), onExecuted: () => {} });
  const client = React.useMemo(() => createMachinePresetCollectionClient(scope, homeId), [homeId, scope]);
  const settle = (value: Readonly<{ kind: string; preset?: { id: string }; code?: string }>) => {
    setBusy(false);
    if (value.kind === 'saved' && value.preset) { onClose(); onSaved(value.preset.id); }
    else setFailure(value.code ?? value.kind);
  };
  const facts = (source: MachineSetupSourceEntryV1) => describeMachineSetup(source.setup).filter((fact) => fact.id !== 'setup-items');
  const capturedFacts = capture.sources.flatMap((source) => facts(source).map((fact) => ({ ...fact, source })));
  const hasContent = capture.rows.length > unticked.size || capturedFacts.length > 0;
  const trimmed = name.trim();
  const save = async () => {
    setBusy(true);
    setFailure(null);
    const result = await client.capture({ homeId, id: randomUUID(), name: trimmed, owner: { kind: 'account', accountId: scope.accountId } }, capture.sources, {
      onApprovalPending: approval.requestApproval,
      onApprovalSucceeded: settle,
      onApprovalFailed: (code) => { setBusy(false); setFailure(code); },
    });
    if (result.kind === 'succeeded') settle(result.value);
    else if (result.kind === 'failed') { setBusy(false); setFailure(result.code); }
    else setBusy(false);
  };
  const disabledReason = trimmed.length === 0 ? t('machinePresets.setup.tab.captureNoName')
    : !hasContent ? t('machinePresets.setup.tab.captureNothing') : undefined;
  const footer = (
    <MachineSetupReviewFooter onCancel={onClose} cancelTestID="machine-save-preset.cancel" note={null}
      primary={approval.approvalPending ? undefined : {
        label: t('machinePresets.setup.tab.captureSave'), testID: 'machine-save-preset.save',
        loading: busy, disabled: busy || disabledReason !== undefined, disabledReason, onPress: () => { void save(); },
      }} />
  );
  const footerRef = React.useRef(footer);
  footerRef.current = footer;
  const footerKey = JSON.stringify([busy, disabledReason ?? null, approval.approvalPending, trimmed, include, [...unticked]]);
  const chrome = React.useMemo(() => ({
    kind: 'card' as const,
    title: t('machinePresets.setup.tab.captureTitle', { machine: machineName }),
    subtitle: t('machinePresets.setup.tab.captureDescription', { machine: machineName }),
    footer: footerRef.current,
    phonePresentation: 'fullscreen' as const,
    dimensions: { size: 'md' as const, maxHeightRatio: 0.84 },
  }), [footerKey, machineName]);
  useModalCardChrome(setChrome, chrome);

  const toggle = (key: string) => setUnticked((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const origin = (source: MachineSetupSourceEntryV1) => source.kind === 'direct' ? nameOf(source) : t('machinePresets.setup.tab.fromPreset', { preset: nameOf(source) });
  const itemRow = (row: MachineSetupCaptureRow) => {
    const read = machineSetupItemReadRow(row.item, machineSetupItemPresentation(row.item, offers));
    const on = !unticked.has(row.key);
    return <Item key={row.key} testID={`machine-save-preset.item:${row.key}`} {...read} subtitle={joinHappierFacts(origin(row.source), read.subtitle)}
      subtitleLines={0} accessibilityRole="checkbox" accessibilityChecked={on} showChevron={false}
      selected={on}
      rightElement={<Icon name={on ? 'check-square' : 'square'} size={20} weight={on ? 'fill' : 'regular'} color={on ? theme.colors.text.primary : theme.colors.text.tertiary} />}
      onPress={() => toggle(row.key)} />;
  };
  const hasApps = capture.rows.some((row) => row.item.kind === 'app');
  return (
    <ItemList presentation="page" keyboardShouldPersistTaps="handled" testID="machine-save-preset">
      {failure ? <SurfaceStateCard testID="machine-save-preset.failure" kind="error" size="line"
        title={t('machinePresets.setup.tab.captureFailed')} diagnosticCode={failure} /> : null}
      {approval.approvalId ? <AttentionBanner testID="machine-save-preset.approval" title={t('approvals.title')} description={t('approvals.status.open')}
        action={{ label: t('approvals.details'), onPress: approval.openApproval }} /> : null}
      <ItemGroup>
        <Item title={t('machinePresets.setup.tab.captureName')} accessoryLayout="stacked" showChevron={false}
          rightElement={<FieldTextInput testID="machine-save-preset.name" value={name} onChangeText={setName}
            accessibilityLabel={t('machinePresets.setup.tab.captureName')} />} />
        {attached.length > 0 ? <SegmentedChoiceItem testIDPrefix="machine-save-preset.include"
          title={t('machinePresets.setup.tab.captureInclude')} accessoryLayout="stacked" value={include} onChange={setInclude}
          options={[
            { id: 'everything', label: t('machinePresets.setup.tab.captureIncludeAll'),
              description: t('machinePresets.setup.tab.captureIncludeHelp', { machine: machineName, presets: attached.map(nameOf).join(', ') }) },
            { id: 'own', label: t('machinePresets.setup.tab.captureIncludeOwn') },
          ]} /> : null}
      </ItemGroup>
      <ItemGroup title={t('machinePresets.setup.tab.captureSaved')} testID="machine-save-preset.saved">{null}</ItemGroup>
      {KIND_GROUPS.map(({ kind, title }) => {
        const ofKind = capture.rows.filter((row) => row.item.kind === kind);
        const kindFacts = kind === 'setupRecipe' ? capturedFacts : [];
        const count = ofKind.length + kindFacts.length;
        return count === 0 ? null : (
          <ItemGroup key={kind} title={t(title)} titleAccessory={<ManagedSectionCount count={count} />}>
            {ofKind.map(itemRow)}
            {kindFacts.map((fact) => <Item key={`${fact.id}:${nameOf(fact.source)}`} title={fact.label} mode="info" showChevron={false}
              subtitle={joinHappierFacts(fact.value, origin(fact.source))} subtitleLines={0} />)}
          </ItemGroup>
        );
      })}
      <ItemGroup title={t('machinePresets.setup.tab.captureNotSaved')} testID="machine-save-preset.not-saved">
        {capture.leftOut.map((source, index) => <Item key={`left:${index}`} title={nameOf(source)}
          subtitle={t('machinePresets.setup.tab.captureLeftOut')} subtitleLines={0} mode="info" showChevron={false} />)}
        {hasApps ? <Item title={t('machinePresets.setup.tab.captureAppData')} subtitleLines={0}
          subtitle={t('machinePresets.setup.tab.captureAppDataHelp', { machine: machineName })} mode="info" showChevron={false} /> : null}
        <Item title={t('machinePresets.setup.tab.captureEverythingElse', { machine: machineName })} subtitleLines={0}
          subtitle={t('machinePresets.setup.tab.captureEverythingElseHelp')} mode="info" showChevron={false} />
      </ItemGroup>
    </ItemList>
  );
}

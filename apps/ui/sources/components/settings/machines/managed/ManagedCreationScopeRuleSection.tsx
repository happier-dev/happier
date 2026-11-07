import { useManagedCreationScopeBirth } from './useManagedCreationScopeBirth';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveTriggerEditorHref } from '@/components/workflows/triggers/triggerEditorDestination';
import { useWorkflowTriggerSets } from '@/components/workflows/triggers/useWorkflowTriggerSets';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
  useSession,
  getStorage,
} from '@/sync/domains/state/storage';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
  readManagedCreationScopeRule,
  isManagedCreationScopeBirthSession,
  readManagedCreationScopeBirthSessionId,
  type ManagedCreationScopeRule,
} from '@/sync/ops/actions/managedCreationScopeBinding';
import {
  getSessionName,
  getSessionSubtitle,
} from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';

import { ManagedScopeRuleRow } from './ManagedMachineDetailSections';
import { formatRetentionDuration } from './managedRetentionPresentation';

/** The machine's Home retention owner supplies the choice; birth supplies its source. */
export function ManagedCreationScopeRuleSection(
  props: Readonly<{ machine: ManagedMachineV1; serverId: string; binding?: ServerCredentialAccountScopeBinding; onChange?: (effect: 'keep' | 'stop' | 'delete') => void; disabled?: boolean; supportedEffects: readonly ('stop' | 'delete')[] }>,
) {
  const binding = props.binding;
  if (!binding?.isCurrent() || !areServerProfileIdentifiersEquivalent(binding.serverId, props.serverId)) return null;
  return <ScopeRuleReader machine={props.machine} serverId={props.serverId} accountId={binding.accountId} binding={binding} onChange={props.onChange} disabled={props.disabled} supportedEffects={props.supportedEffects} />;
}

function ScopeRuleReader(
  props: Readonly<{ machine: ManagedMachineV1; serverId: string; accountId: string; binding: ServerCredentialAccountScopeBinding; onChange?: (effect: 'keep' | 'stop' | 'delete') => void; disabled?: boolean; supportedEffects: readonly ('stop' | 'delete')[] }>,
) {
  const birthRead = useManagedCreationScopeBirth(props.machine, props.binding);
  const rule = readManagedCreationScopeRule(props.machine, birthRead.source);
  const source = birthRead.source ?? rule?.binding.source;
  if (!source) {
    // A failed exact birth read is not "made for nothing": keep its place with the cause and the same read's Retry.
    // Pending and a known absent birth stay silent; most machines were not created for a session or task.
    return birthRead.status === 'failed' ? (
      <ItemGroup testID="managed-machine.scope-birth">
        <SurfaceStateCard
          testID="managed-machine.scope-birth-failed"
          size="line"
          kind="warning"
          title={t('managedRetention.scopeBirthFailed', { name: props.machine.launch.name })}
          diagnosticCode="managed_birth_lookup_failed"
          action={{ label: t('common.retry'), testID: 'managed-machine.scope-birth-failed:retry', onPress: birthRead.retry }}
        />
      </ItemGroup>
    ) : null;
  }
  return (
    <ScopeRuleSection
      rule={rule ?? undefined}
      source={source}
      canEdit={props.accountId === props.machine.custodianAccountId && birthRead.status === 'ready'}
      readStatus={birthRead.status === 'pending' ? 'loading' : birthRead.status}
      onChange={props.onChange}
      disabled={props.disabled}
      machineName={props.machine.launch.name}
      supportedEffects={props.supportedEffects}
      serverId={props.serverId}
    />
  );
}

function describeScopeRule(
  rule: ManagedCreationScopeRule,
  name: string,
): string {
  const duration =
    rule.afterMs === undefined ? null : formatRetentionDuration(rule.afterMs);
  const effect =
    rule.effect === 'stop'
      ? duration
        ? t('managedRetention.scopeRuleStop', { name, duration })
        : t('managedRetention.scopeRuleStopIdle', { name })
      : duration
        ? t('managedRetention.scopeRuleDelete', { name, duration })
        : t('managedRetention.scopeRuleDeleteIdle', { name });
  // While its run waits the row leads with that; the chosen-at-creation note would only repeat history.
  return rule.waiting
    ? effect
    : t('managedRetention.scopeRuleChosen', { rule: effect, name });
}

function ScopeRuleSection(
  props: Readonly<{
    rule?: ManagedCreationScopeRule;
    source: ManagedCreationScopeRule['binding']['source'];
    canEdit: boolean;
    readStatus: 'loading' | 'ready' | 'failed';
    machineName: string;
    supportedEffects: readonly ('stop' | 'delete')[];
    serverId: string;
    onChange?: (effect: 'keep' | 'stop' | 'delete') => void;
    disabled?: boolean;
  }>,
) {
  const [open, setOpen] = React.useState(false);
  const { rule } = props;
  const source = props.source;
  const summary = rule ? describeScopeRule(rule, props.machineName) : props.readStatus === 'loading' ? t('common.loading')
    : props.readStatus === 'failed' ? t('managedMachines.options.unavailable') : t('common.keep');

  return (
    <ItemGroup
      title={t(
        source.kind === 'session'
          ? 'managedRetention.scopeSessionTitle'
          : 'managedRetention.scopeTaskTitle',
      )}
      description={t(
        source.kind === 'session'
          ? 'managedRetention.createdForSession'
          : 'managedRetention.createdForTask',
      )}
    >
      {source.kind === 'session' ? (
        <ScopeSessionRow
          sessionId={source.sessionId}
          serverId={props.serverId}
        />
      ) : null}
      {props.canEdit && props.onChange ? <DropdownMenu open={open} onOpenChange={setOpen}
        variant="selectable" search={false} selectedId={rule?.effect ?? 'keep'} showCategoryTitles={false}
        matchTriggerWidth connectToTrigger rowKind="item"
        trigger={({ openMenu }) => <ManagedScopeRuleRow testID="managed-machine.scope-rule" rule={{
          scope: source.kind === 'session' ? 'session' : 'task', summary, waiting: rule?.waiting,
          onOpen: props.disabled ? undefined : openMenu,
        }} />}
        items={['keep' as const, ...props.supportedEffects]
          .map(effect => ({ id: effect, title: t(effect === 'keep' ? 'common.keep' : effect === 'stop' ? 'common.stop' : 'common.delete') }))}
        onSelect={effect => { setOpen(false); if (effect === 'keep' || effect === 'stop' || effect === 'delete') props.onChange?.(effect); }} />
        : <ManagedScopeRuleRow testID="managed-machine.scope-rule" rule={{
          scope: source.kind === 'session' ? 'session' : 'task', summary, waiting: rule?.waiting,
        }} />}

    </ItemGroup>
  );
}

function ScopeSessionRow(
  props: Readonly<{ sessionId: string; serverId: string }>,
) {
  const { theme } = useUnistyles();
  const session = useSession(props.sessionId, props.serverId);
  const navigateToSession = useNavigateToSession();
  // An unloaded session has no local name to show; the exact birth still supplies its scope.
  if (!session) return null;
  return (
    <Item
      testID="managed-machine.scope-session"
      title={getSessionName(session, props.serverId)}
      subtitle={getSessionSubtitle(session, props.serverId)}
      icon={
        <Icon
          name="chat-circle-dots"
          size={20}
          color={theme.colors.text.secondary}
        />
      }
      onPress={() =>
        navigateToSession(props.sessionId, { serverId: props.serverId })
      }
    />
  );
}

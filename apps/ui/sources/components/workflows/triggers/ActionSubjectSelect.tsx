import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  automationSubjectKeyV1,
  type AutomationSubjectV1,
} from '@happier-dev/protocol/automations/automationSubjectV1';

import { HappierAutomationSubjectPicker, type HappierAutomationSubjectPickerRow } from '@happier-dev/plugin-ui/presentation';

import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import type { WorkflowActionOperand } from '@/components/workflows/presentation/workflowActionCatalog';
import { areServerAccountScopesEqual, readServerAccountScopeOwnerLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeStates } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
  useAutomationSubjectPicker,
  type AutomationSubjectPickerInput,
} from '@/sync/domains/workflows/useAutomationSubjectPicker';
import { readAutomationSubjectPickerSelection, type DatabaseSubjectPickerLocation } from '@/sync/domains/workflows/automationSubjectPicker';
import { useProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import { projectWorkspaceRefV1, workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { isManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScopeLifetime, useServerScopedMachine } from '@/sync/store/hooks';
import { t } from '@/text';

const ANY = 'subject:any';
const DATABASE_LOCATIONS = 'subject:database-locations';
const DATABASE_WORKTREE = 'subject:database-worktree';

const ALWAYS = () => true;

/** The shared subject menu drawn as this form's labelled field. */
function SubjectFieldMenu(props: Readonly<{
  testID?: string;
  label?: string;
  onOpenChange(open: boolean): void;
  items: readonly HappierAutomationSubjectPickerRow[];
  selectedId: string | null;
  onSelect(id: string): void;
  emptyLabel: string;
}>) {
  const { items } = props;
  const keepsOpen = React.useCallback((id: string) => items.some(item => item.id === id && item.keepMenuOpen === true), [items]);
  return <ValueFieldSelect testID={props.testID ?? 'subject'} label={props.label ?? ''} items={items}
    selectedId={props.selectedId} onSelect={props.onSelect} onOpenChange={props.onOpenChange}
    keepsOpen={keepsOpen} emptyLabel={props.emptyLabel} />;
}

type CoreKind = Exclude<WorkflowActionOperand['kind']['kind'], 'plugin'>;

/** What the operand is called (the row's label), what "this one" and "any" read as, from the kind's own copy. */
export function formatActionOperand(
  operand: WorkflowActionOperand,
): Readonly<{ label: string; this: string; any: string }> {
  const kind = operand.kind.kind;
  if (kind !== 'plugin') {
    const core: CoreKind = kind;
    return {
      label: t(`workflows.triggers.card.subjectKinds.${core}.label`),
      this: t(`workflows.triggers.card.subjectKinds.${core}.this`),
      any: t(`workflows.triggers.card.subjectKinds.${core}.any`),
    };
  }
  const label = operand.label ?? t('workflows.triggers.card.subjectResource');
  return {
    label,
    this: t('workflows.triggers.card.subjectThis', { kind: label }),
    any: t('workflows.triggers.card.subjectAny', { kind: label }),
  };
}

/** A subject belongs to an operand when it is that kind (and, for a plugin kind, that plugin's kind). */
export function isActionOperandSubject(
  operand: WorkflowActionOperand | undefined,
  subject: AutomationSubjectV1,
): boolean {
  if (operand === undefined || operand.kind.kind !== subject.kind) return false;
  return (
    operand.kind.kind !== 'plugin' ||
    subject.kind !== 'plugin' ||
    (operand.kind.pluginId === subject.pluginId &&
      operand.kind.subjectKindId === subject.subjectKindId)
  );
}

/** The kind a saved subject already names (identity only; a plugin kind's name and list come with its declaration). */
export function readSubjectOperand(subject: AutomationSubjectV1): WorkflowActionOperand {
  return {
    kind: subject.kind === 'plugin'
      ? { kind: 'plugin', pluginId: subject.pluginId, subjectKindId: subject.subjectKindId }
      : ({ kind: subject.kind } as WorkflowActionOperand['kind']),
  };
}

/**
 * Which resource a before/after trigger is about (lab `actrig:v:before|envpop|psubject`): **Any ⟨kind⟩** (no subject),
 * or one resource of the Action's declared operand kind read on demand through the shared subject picker. The kind is
 * the Action's own declaration; this select never chooses it.
 */
export const ActionSubjectSelect = React.memo(function ActionSubjectSelect(
  props: Readonly<{
    testID: string;
    operand: WorkflowActionOperand;
    subject: AutomationSubjectV1 | undefined;
    machineId: string | null;
    serverId: string | null;
    workspaceRefId?: string;
    onChange: (subject: AutomationSubjectV1 | undefined) => void;
    onSubjectNamed?: (subject: Readonly<{ key: string; label: string }> | null) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { operand } = props;
  const words = formatActionOperand(operand);
  const [open, setOpen] = React.useState(false);
  // The last chosen resource's name: a saved subject carries only its identity.
  const [chosen, setChosen] = React.useState<Readonly<{
    key: string;
    label: string;
  }> | null>(null);
  const active = useActiveServerAccountScopeLifetime();
  const serverId = props.serverId ?? active?.scope.serverId ?? null;
  // A saved Environment or Backup is named by its owner's exact selection read, without opening the list.
  const saved = props.subject?.kind === 'environment' || props.subject?.kind === 'backup' ? props.subject : null;
  const savedKey = saved ? automationSubjectKeyV1(saved) : null;
  const savedUnnamed = savedKey !== null && chosen?.key !== savedKey;
  const accounts = useServerCredentialAccountScopeStates(
    (open || savedUnnamed) && serverId !== null ? [serverId] : [],
  );
  const binding = accounts.values().next().value?.binding ?? null;
  const lifetime = React.useMemo(
    () => (binding ? readServerAccountScopeOwnerLifetime(binding) : null),
    [binding],
  );
  const kind = operand.kind;
  const database = kind.kind === 'database';
  const [location, setLocation] = React.useState<DatabaseSubjectPickerLocation | null>();
  const savedWorktree = props.subject?.kind === 'database' && props.subject.target.kind === 'worktree' ? props.subject.target : null;
  const workspaceRefId = database && open ? props.workspaceRefId : undefined;
  const checkout = useProjectAccountRows(rows => {
    if (!rows || !lifetime || !workspaceRefId || !areServerAccountScopesEqual(rows.scope, lifetime.scope)) return null;
    const resolved = resolveWorkspaceRefById(rows.workspaceRefs, workspaceRefId, lifetime.scope.serverId);
    return resolved.kind === 'resolved' ? resolved.ref : null;
  }, workspaceRefId !== undefined);
  const checkoutMachineId = checkout === null ? null : isManagedWorkspaceRefV2(checkout) ? checkout.controller.machineId : checkout.machineId;
  const installationId = useServerScopedMachine(serverId, checkoutMachineId, machine => machine?.installationId ?? null);
  const worktreeLocation = React.useMemo((): DatabaseSubjectPickerLocation | null => {
    if (lifetime === null) return null;
    if (savedWorktree && savedWorktree.accountId === lifetime.scope.accountId
        && areServerProfileIdentifiersEquivalent(savedWorktree.workspace.serverId, lifetime.scope.serverId)) {
      const { source: _source, ...scope } = savedWorktree;
      return { scope, machineId: 'controller' in scope.workspace ? scope.workspace.controller.machineId : scope.workspace.machineId };
    }
    if (checkout === null || checkoutMachineId === null || !installationId) return null;
    return { machineId: checkoutMachineId, scope: { kind: 'worktree', accountId: lifetime.scope.accountId,
      projectKey: projectWorkspaceRefV1(checkout).projectKey, workspace: workspaceAddressFromRefV2(checkout), installationId } };
  }, [savedWorktree, checkout, checkoutMachineId, installationId, lifetime]);
  const databaseLocation = database ? location === undefined && savedWorktree !== null ? worktreeLocation : location ?? null : null;
  const choosingDatabaseLocation = database && databaseLocation === null;
  const targetMachineId = database ? databaseLocation?.machineId : props.machineId;
  const context = React.useMemo(
    () =>
      targetMachineId
        ? {
            externalActionTarget: {
              kind: 'machine' as const,
              machineId: targetMachineId,
            },
          }
        : undefined,
    [targetMachineId],
  );
  const declaration = operand.declaration;
  const input = React.useMemo((): AutomationSubjectPickerInput => {
    const common = { lifetime, demanded: open, ...(context === undefined ? {} : { context }) };
    if (kind.kind === 'plugin') return { ...common, kind, page: {}, subjectKinds: declaration === undefined ? [] : [declaration] };
    if (kind.kind === 'healthCheck') return { ...common, kind, page: {} };
    if (kind.kind === 'database') return databaseLocation === null
      ? { ...common, kind: { kind: 'environment' } }
      : { ...common, kind, databaseScope: databaseLocation.scope };
    return { ...common, kind } as AutomationSubjectPickerInput;
  }, [lifetime, open, context, kind, declaration, databaseLocation]);
  const read = useAutomationSubjectPicker(input);
  const savedRef = React.useRef(saved);
  savedRef.current = saved;
  React.useEffect(() => {
    const subject = savedRef.current;
    if (!savedUnnamed || subject === null || lifetime === null) return;
    const controller = new AbortController();
    void readAutomationSubjectPickerSelection({ lifetime, subject, signal: controller.signal })
      .then((option) => {
        if (option && !controller.signal.aborted) setChosen({ key: automationSubjectKeyV1(subject), label: option.label });
      })
      // Unreadable, it keeps reading "This environment"; the open list still names every choice.
      .catch(() => {});
    return () => controller.abort();
  }, [savedKey, savedUnnamed, lifetime]);
  const selectedKey =
    props.subject === undefined ? ANY : automationSubjectKeyV1(props.subject);
  const { onSubjectNamed } = props;
  React.useEffect(() => {
    onSubjectNamed?.(chosen?.key === selectedKey ? chosen : null);
  }, [chosen, onSubjectNamed, selectedKey]);
  const iconColor = theme.colors.text.secondary;
  // The shared subject menu draws the choices and the list's Loading, Retry and More; this field leads with Any and,
  // for a Database, the Environment step that narrows the list before a database is chosen.
  const leading = React.useMemo<HappierAutomationSubjectPickerRow[]>(() => [
    {
      id: ANY,
      title: words.any,
      subtitle: t('workflows.triggers.card.subjectAnyNote'),
      icon: <Icon name="squares-four" size={ICON_SIZE.xs} color={iconColor} />,
    },
    ...(databaseLocation === null ? [] : [{ id: DATABASE_LOCATIONS, title: t('common.back'), keepMenuOpen: true }]),
    ...(choosingDatabaseLocation && worktreeLocation && checkout
      ? [{ id: DATABASE_WORKTREE, title: checkout.rootPath, keepMenuOpen: true }] : []),
  ], [words.any, iconColor, databaseLocation, choosingDatabaseLocation, worktreeLocation, checkout]);
  const formatChoice = React.useCallback((option: Readonly<{ label: string }>, selected: boolean) =>
    selected ? `${words.this} · ${option.label}` : option.label, [words.this]);
  const retained = React.useMemo(() => selectedKey === ANY ? null : {
    id: selectedKey,
    title: chosen?.key === selectedKey ? `${words.this} · ${chosen.label}` : words.this,
  }, [selectedKey, chosen, words.this]);
  const { onChange } = props;
  const selectLeading = React.useCallback((id: string) => {
    if (id === ANY) onChange(undefined);
    else if (id === DATABASE_LOCATIONS) setLocation(null);
    else if (id === DATABASE_WORKTREE) setLocation(worktreeLocation);
  }, [onChange, worktreeLocation]);
  const choose = React.useCallback((subject: AutomationSubjectV1, option: (typeof read.items)[number]) => {
    if (choosingDatabaseLocation) {
      if (option.databaseLocation) setLocation(option.databaseLocation);
      return;
    }
    setChosen({ key: automationSubjectKeyV1(subject), label: option.label });
    onChange(subject);
  }, [choosingDatabaseLocation, onChange]);
  const openChange = React.useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setLocation(undefined);
  }, []);
  return (
    <HappierAutomationSubjectPicker Menu={SubjectFieldMenu} testID={props.testID} fieldLabel={words.label}
        open={open} onOpenChange={openChange} value={props.subject ?? null} selectedId={selectedKey}
        options={read.items} subjectKey={automationSubjectKeyV1} formatChoice={formatChoice}
        leading={leading} onSelectLeading={selectLeading} retained={retained} narrowing={choosingDatabaseLocation}
        waiting={read.status === 'loading' || read.status === 'loading_more' || (open && lifetime === null && serverId !== null)}
        failed={read.status === 'error'} hasMore={read.hasMore} canSelect={ALWAYS}
        onRetry={read.reload} onLoadMore={read.loadMore} onChange={choose}
        chooseLabel={words.label} emptyLabel={t('common.noMatches')} loadingLabel={t('common.loading')}
        retryLabel={t('common.retry')} failureLabel={t('common.requestFailed')} moreLabel={t('common.more')} />
  );
});

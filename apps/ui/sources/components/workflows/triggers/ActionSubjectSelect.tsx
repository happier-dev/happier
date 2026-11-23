import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  automationSubjectKeyV1,
  type AutomationSubjectV1,
} from '@happier-dev/protocol/automations/automationSubjectV1';

import {
  ValueFieldSelect,
  type ValueFieldSelectItem,
} from '@/components/ui/forms/ValueFieldSelect';
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
const MORE = 'subject:more';
const RETRY = 'subject:retry';
const LOADING = 'subject:loading';
const DATABASE_LOCATIONS = 'subject:database-locations';
const DATABASE_WORKTREE = 'subject:database-worktree';
const DATABASE_LOCATION_PREFIX = 'subject:database-location:';
const KEEPS_OPEN = (id: string) => id === MORE || id === RETRY || id === DATABASE_LOCATIONS || id === DATABASE_WORKTREE || id.startsWith(DATABASE_LOCATION_PREFIX);

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
  const items = React.useMemo<ValueFieldSelectItem[]>(() => {
    const listed = read.items.map((item) => {
      const key = automationSubjectKeyV1(item.subject);
      return {
        id: choosingDatabaseLocation ? DATABASE_LOCATION_PREFIX + key : key,
        title:
          key === selectedKey ? `${words.this} · ${item.label}` : item.label,
        ...(item.description === undefined
          ? {}
          : { subtitle: item.description }),
      };
    });
    const rows: ValueFieldSelectItem[] = [
      {
        id: ANY,
        title: words.any,
        subtitle: t('workflows.triggers.card.subjectAnyNote'),
        icon: (
          <Icon name="squares-four" size={ICON_SIZE.xs} color={iconColor} />
        ),
      },
      ...(databaseLocation === null ? [] : [{ id: DATABASE_LOCATIONS, title: t('common.back') }]),
      ...(choosingDatabaseLocation && worktreeLocation && checkout ? [{ id: DATABASE_WORKTREE, title: checkout.rootPath }] : []),
      ...listed,
    ];
    if (
      read.status === 'loading' ||
      read.status === 'loading_more' ||
      (open && lifetime === null && serverId !== null)
    ) {
      rows.push({ id: LOADING, title: t('common.loading'), disabled: true });
    } else if (read.status === 'error') {
      rows.push({
        id: RETRY,
        title: t('common.retry'),
        subtitle: t('common.requestFailed'),
      });
    } else if (read.hasMore) {
      rows.push({ id: MORE, title: t('common.more') });
    }
    // A saved resource the open list has not reached still reads as chosen.
    if (
      selectedKey !== ANY &&
      !listed.some((item) => item.id === selectedKey)
    ) {
      rows.splice(1, 0, {
        id: selectedKey,
        title:
          chosen?.key === selectedKey
            ? `${words.this} · ${chosen.label}`
            : words.this,
      });
    }
    return rows;
  }, [
    read.items,
    read.status,
    read.hasMore,
    selectedKey,
    chosen,
    words.this,
    words.any,
    iconColor,
    open,
    lifetime,
    serverId,
    choosingDatabaseLocation,
    databaseLocation,
    worktreeLocation,
    checkout,
  ]);
  const { onChange } = props;
  const select = React.useCallback(
    (id: string) => {
      if (id === MORE) {
        void read.loadMore();
        return;
      }
      if (id === RETRY) {
        void read.reload();
        return;
      }
      if (id === LOADING) return;
      if (id === DATABASE_LOCATIONS) {
        setLocation(null);
        return;
      }
      if (id === DATABASE_WORKTREE) {
        setLocation(worktreeLocation);
        return;
      }
      if (id.startsWith(DATABASE_LOCATION_PREFIX)) {
        const option = read.items.find(item => automationSubjectKeyV1(item.subject) === id.slice(DATABASE_LOCATION_PREFIX.length));
        if (option?.databaseLocation) setLocation(option.databaseLocation);
        return;
      }
      if (id === ANY) {
        onChange(undefined);
        return;
      }
      const item = read.items.find(
        (candidate) => automationSubjectKeyV1(candidate.subject) === id,
      );
      if (!item) return;
      setChosen({ key: id, label: item.label });
      onChange(item.subject);
    },
    [read, onChange, worktreeLocation],
  );
  return (
    <ValueFieldSelect
      testID={props.testID}
      label={words.label}
      items={items}
      selectedId={selectedKey}
      onSelect={select}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setLocation(undefined);
      }}
      keepsOpen={KEEPS_OPEN}
      emptyLabel={t('common.noMatches')}
    />
  );
});

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
import { readServerAccountScopeOwnerLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeStates } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
  useAutomationSubjectPicker,
  type AutomationSubjectPickerInput,
} from '@/sync/domains/workflows/useAutomationSubjectPicker';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { t } from '@/text';

const ANY = 'subject:any';
const MORE = 'subject:more';
const RETRY = 'subject:retry';
const LOADING = 'subject:loading';
const KEEPS_OPEN = (id: string) => id === MORE || id === RETRY;

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
    onChange: (subject: AutomationSubjectV1 | undefined) => void;
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
  const accounts = useServerCredentialAccountScopeStates(
    open && serverId !== null ? [serverId] : [],
  );
  const binding = accounts.values().next().value?.binding ?? null;
  const lifetime = React.useMemo(
    () => (binding ? readServerAccountScopeOwnerLifetime(binding) : null),
    [binding],
  );
  const context = React.useMemo(
    () =>
      props.machineId
        ? {
            externalActionTarget: {
              kind: 'machine' as const,
              machineId: props.machineId,
            },
          }
        : undefined,
    [props.machineId],
  );
  const kind = operand.kind;
  const declaration = operand.declaration;
  const input = React.useMemo((): AutomationSubjectPickerInput => {
    const common = { lifetime, demanded: open, ...(context === undefined ? {} : { context }) };
    if (kind.kind === 'plugin') return { ...common, kind, page: {}, subjectKinds: declaration === undefined ? [] : [declaration] };
    if (kind.kind === 'healthCheck') return { ...common, kind, page: {} };
    return { ...common, kind } as AutomationSubjectPickerInput;
  }, [lifetime, open, context, kind, declaration]);
  const read = useAutomationSubjectPicker(input);
  const selectedKey =
    props.subject === undefined ? ANY : automationSubjectKeyV1(props.subject);
  const iconColor = theme.colors.text.secondary;
  const items = React.useMemo<ValueFieldSelectItem[]>(() => {
    const listed = read.items.map((item) => {
      const key = automationSubjectKeyV1(item.subject);
      return {
        id: key,
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
    [read, onChange],
  );
  return (
    <ValueFieldSelect
      testID={props.testID}
      label={words.label}
      items={items}
      selectedId={selectedKey}
      onSelect={select}
      onOpenChange={setOpen}
      keepsOpen={KEEPS_OPEN}
      emptyLabel={
        read.status === 'unsupported'
          ? t('common.unavailable')
          : t('common.noMatches')
      }
    />
  );
});

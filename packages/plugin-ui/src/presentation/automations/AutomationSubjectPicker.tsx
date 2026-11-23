import { useCallback, useMemo, useState, type ComponentType, type ReactElement, type ReactNode } from 'react';

/** One row of the subject menu: a subject, a row the host leads with (Any, Back), or the list's own Loading/Retry/More. */
export type HappierAutomationSubjectPickerRow = Readonly<{
  id: string;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  testID?: string;
  loading?: boolean;
  disabled?: boolean;
  keepMenuOpen?: boolean;
}>;

type SubjectPickerMenuProps = Readonly<{
  testID?: string;
  /** What is being chosen ("Environment"), for a host menu drawn as a labelled field. */
  label?: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  itemTrigger: Readonly<{ title: string; itemProps: Readonly<{ disabled?: boolean }> }>;
  items: readonly HappierAutomationSubjectPickerRow[];
  selectedId: string | null;
  onSelect(id: string): void;
  emptyLabel: string;
}>;

type SubjectOption<Subject> = Readonly<{ subject: Subject; label: string; description?: string }>;

const MORE = 'picker:more';
const RETRY = 'picker:retry';
const LOADING = 'picker:loading';

/**
 * The one subject menu: the held choices, then Loading, Retry or More, drawn through the physical host's menu (its
 * dropdown, or a field select). A trigger's subject field leads with its own rows (Any, Back) and names the chosen
 * subject ("This environment · Production"); a choice that only narrows the list (a Database's Environment) keeps the
 * menu open and leaves the selection to the caller.
 */
export function HappierAutomationSubjectPicker<Subject, Option extends SubjectOption<Subject> = SubjectOption<Subject>>(props: Readonly<{
  Menu: ComponentType<SubjectPickerMenuProps>;
  testID?: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  value: Subject | null;
  options: readonly Option[];
  subjectKey(subject: Subject): string;
  waiting: boolean;
  failed: boolean;
  hasMore: boolean;
  disabled?: boolean;
  canSelect(): boolean;
  onRetry(): void;
  onLoadMore(): void;
  onChange(subject: Subject, option: Option): void;
  /** Rows before the choices; choosing one calls `onSelectLeading`. */
  leading?: readonly HappierAutomationSubjectPickerRow[];
  onSelectLeading?(id: string): void;
  /** A choice's title; `selected` is the chosen subject's own row. */
  formatChoice?(option: Option, selected: boolean): string;
  /** The chosen subject's row while the list has not reached it; absent, the picker keeps the last choice it made. */
  retained?: HappierAutomationSubjectPickerRow | null;
  /** The choices narrow the list rather than choose: each keeps the menu open. */
  narrowing?: boolean;
  /** The menu's selected row when it is not the value's own (Any). */
  selectedId?: string | null;
  /** What is being chosen, for a host menu drawn as a labelled field. */
  fieldLabel?: string;
  chooseLabel: string;
  emptyLabel: string;
  loadingLabel: string;
  retryLabel: string;
  failureLabel: string;
  moreLabel: string;
}>): ReactElement {
  const { Menu, options, subjectKey, open, onOpenChange, onRetry, onLoadMore, onChange, canSelect, formatChoice,
    narrowing, onSelectLeading } = props;
  const [selected, setSelected] = useState<HappierAutomationSubjectPickerRow | null>(null);
  const valueId = props.value === null ? null : subjectKey(props.value);
  const choiceId = useCallback((subject: Subject) => (narrowing ? 'narrow:' : '') + subjectKey(subject), [narrowing, subjectKey]);
  const choices = useMemo(() => options.map((item): HappierAutomationSubjectPickerRow => {
    const key = subjectKey(item.subject);
    return {
      id: choiceId(item.subject),
      title: formatChoice ? formatChoice(item, key === valueId) : item.label,
      ...(item.description === undefined ? {} : { subtitle: item.description }),
      ...(narrowing ? { keepMenuOpen: true } : {}),
    };
  }), [options, subjectKey, choiceId, formatChoice, valueId, narrowing]);
  const selectedId = props.selectedId !== undefined ? props.selectedId : valueId;
  const { waiting, failed, hasMore, testID, loadingLabel, retryLabel, failureLabel, moreLabel } = props;
  const leading = props.leading;
  const retainedProp = props.retained;
  const items = useMemo(() => {
    const items: HappierAutomationSubjectPickerRow[] = [...(leading ?? []), ...choices];
    if (waiting) items.push({ id: LOADING, title: loadingLabel, loading: true, disabled: true });
    else if (failed) items.push({ id: RETRY, title: retryLabel, subtitle: failureLabel,
      testID: testID === undefined ? undefined : `${testID}-retry`, keepMenuOpen: true });
    else if (hasMore) items.push({ id: MORE, title: moreLabel,
      testID: testID === undefined ? undefined : `${testID}-more`, keepMenuOpen: true });
    // A chosen subject the open list has not reached still reads as chosen.
    const retained = retainedProp !== undefined ? retainedProp : !open && selected?.id === valueId ? selected : null;
    if (retained && !items.some(item => item.id === retained.id)) items.splice(leading?.length ?? 0, 0, retained);
    return items;
  }, [leading, choices, waiting, failed, hasMore, testID, loadingLabel, retryLabel, failureLabel, moreLabel, retainedProp,
    open, selected, valueId]);
  const select = useCallback((id: string) => {
    if (!canSelect()) return;
    if (id === MORE) { onLoadMore(); return; }
    if (id === RETRY) { onRetry(); return; }
    if (id === LOADING) return;
    const index = choices.findIndex(item => item.id === id);
    const option = options[index];
    if (!option) {
      if (leading?.some(row => row.id === id)) onSelectLeading?.(id);
      return;
    }
    if (!narrowing) setSelected(choices[index]!);
    onChange(option.subject, option);
    if (!narrowing) onOpenChange(false);
  }, [canSelect, onLoadMore, onRetry, choices, options, leading, onSelectLeading, narrowing, onChange, onOpenChange]);

  return <Menu testID={testID} {...(props.fieldLabel === undefined ? {} : { label: props.fieldLabel })} open={open && !props.disabled} onOpenChange={onOpenChange}
    itemTrigger={{ title: props.chooseLabel, itemProps: { disabled: props.disabled } }}
    items={items} selectedId={selectedId} onSelect={select} emptyLabel={props.emptyLabel} />;
}

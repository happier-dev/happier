import { useCallback, useMemo, useState, type ComponentType, type ReactElement } from 'react';

type SubjectPickerMenuItem = Readonly<{
  id: string;
  title: string;
  subtitle?: string;
  testID?: string;
  loading?: boolean;
  disabled?: boolean;
  keepMenuOpen?: boolean;
}>;

type SubjectPickerMenuProps = Readonly<{
  testID?: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  itemTrigger: Readonly<{ title: string; itemProps: Readonly<{ disabled?: boolean }> }>;
  items: readonly SubjectPickerMenuItem[];
  selectedId: string | null;
  onSelect(id: string): void;
  emptyLabel: string;
}>;

const MORE = 'picker:more';
const RETRY = 'picker:retry';
const LOADING = 'picker:loading';

/** Renders the held choices through the physical host's dropdown (including its focus and overlay behavior). */
export function HappierAutomationSubjectPicker<Subject>(props: Readonly<{
  Menu: ComponentType<SubjectPickerMenuProps>;
  testID?: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  value: Subject | null;
  options: readonly Readonly<{ subject: Subject; label: string; description?: string }>[];
  subjectKey(subject: Subject): string;
  waiting: boolean;
  failed: boolean;
  hasMore: boolean;
  disabled?: boolean;
  canSelect(): boolean;
  onRetry(): void;
  onLoadMore(): void;
  onChange(subject: Subject): void;
  chooseLabel: string;
  emptyLabel: string;
  loadingLabel: string;
  retryLabel: string;
  failureLabel: string;
  moreLabel: string;
}>): ReactElement {
  const { Menu, options, subjectKey, open, onOpenChange, onRetry, onLoadMore, onChange, canSelect } = props;
  const [selected, setSelected] = useState<SubjectPickerMenuItem | null>(null);
  const choices = useMemo(() => options.map(item => ({
    id: subjectKey(item.subject),
    title: item.label,
    ...(item.description === undefined ? {} : { subtitle: item.description }),
  })), [options, subjectKey]);
  const selectedId = props.value === null ? null : subjectKey(props.value);
  const { waiting, failed, hasMore, testID, loadingLabel, retryLabel, failureLabel, moreLabel } = props;
  const items = useMemo(() => {
    const items: SubjectPickerMenuItem[] = [...choices];
    if (waiting) items.push({ id: LOADING, title: loadingLabel, loading: true, disabled: true });
    else if (failed) items.push({ id: RETRY, title: retryLabel, subtitle: failureLabel,
      testID: testID === undefined ? undefined : `${testID}-retry`, keepMenuOpen: true });
    else if (hasMore) items.push({ id: MORE, title: moreLabel,
      testID: testID === undefined ? undefined : `${testID}-more`, keepMenuOpen: true });
    if (!open && selected?.id === selectedId && !items.some(item => item.id === selectedId)) items.push(selected);
    return items;
  }, [choices, waiting, failed, hasMore, testID, loadingLabel, retryLabel, failureLabel, moreLabel, open, selected, selectedId]);
  const select = useCallback((id: string) => {
    if (!canSelect()) return;
    if (id === MORE) { onLoadMore(); return; }
    if (id === RETRY) { onRetry(); return; }
    const index = choices.findIndex(item => item.id === id);
    const item = options[index];
    if (!item) return;
    setSelected(choices[index]!);
    onChange(item.subject);
    onOpenChange(false);
  }, [canSelect, onLoadMore, onRetry, choices, options, onChange, onOpenChange]);

  return <Menu testID={testID} open={open && !props.disabled} onOpenChange={onOpenChange}
    itemTrigger={{ title: props.chooseLabel, itemProps: { disabled: props.disabled } }}
    items={items} selectedId={selectedId} onSelect={select} emptyLabel={props.emptyLabel} />;
}

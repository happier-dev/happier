import { useCallback, useState, type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';

import {
  HappierInputField,
  type HappierInputFieldDescriptor,
} from '../presentation/form/InputField.js';
import { HappierFormActions } from '../presentation/form/Fields.js';
import { Button } from './Button.js';
import { Row, Stack } from './Layout.js';
import { Menu, Popover, type MenuItem } from './Overlay.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { Text } from './Text.js';
import { Badge } from './Foundation.js';
import type { HappierMarkColor } from '../presentation/semantics.js';
import { usePropertyCommit } from './propertyCommit.js';
import { HappierTextActionEdgeContext } from '../presentation/interaction/textActionEdge.js';
import { isHappierPageRowNarrow, readHappierVisibleLayoutWidth } from '../presentation/layout/pageMetrics.js';
import type { HappierLayoutChangeEvent } from '../presentation/portableTypes.js';

/** One choice a property can take: a stable id the author maps back to its value, and the words people read. */
export type PropertyChoice = Readonly<{
  id: string;
  label: string;
  /** Supporting identity ("CHK-214 · Linear"), kept apart from the label. */
  subtitle?: string;
  /** This choice is a person: their name, drawn as an `Avatar` beside the label. */
  person?: string;
  /** A short quiet fact at the row's end (a designation such as "#877"). */
  meta?: string;
}>;

/** @internal One choice as a picker row: its words, supporting identity, person and trailing fact. */
export function propertyChoiceMenuItem(choice: PropertyChoice): PropertyChoice {
  return {
    id: choice.id,
    label: choice.label,
    ...(choice.subtitle === undefined ? {} : { subtitle: choice.subtitle }),
    ...(choice.person === undefined ? {} : { person: choice.person }),
    ...(choice.meta === undefined ? {} : { meta: choice.meta }),
  };
}

/**
 * Choices read from a directory rather than known up front (a people directory). The picker asks for it when it
 * opens, says while it is read, and says in one line when it cannot be read, with one retry when there is one.
 */
export type PropertyChoiceDirectory = Readonly<{
  status: 'loading' | 'ready' | 'unavailable';
  /** The owner reads on demand: called each time the picker opens. */
  onOpen?(): void;
  /** Why no list can be shown, in one line. Defaults to "This list couldn't be loaded". */
  unavailableLabel?: string;
  /** Read it again; absent when there is nothing to retry. */
  retry?(): void;
}>;

/**
 * How a property's value is changed. Each kind is one typed control, and each `onCommit` is one deliberate
 * change: a choice commits when it is picked, typed values when Save is pressed. Nothing commits per keystroke.
 * `null` (or an empty list) means "not set"; a property offers it only when `clearable` is not false.
 */
export type PropertyEditor =
  | Readonly<{
      kind: 'text';
      value: string | null;
      multiline?: boolean;
      placeholder?: string;
      onCommit(next: string | null): unknown;
    }>
  | Readonly<{
      kind: 'number';
      value: number | null;
      integer?: boolean;
      onCommit(next: number | null): unknown;
    }>
  /** A calendar day, `YYYY-MM-DD`, never an instant: no timezone is invented for it. */
  | Readonly<{
      kind: 'date';
      value: string | null;
      onCommit(next: string | null): unknown;
    }>
  /** Free names (labels, people by handle) typed as one comma-separated line. */
  | Readonly<{
      kind: 'list';
      value: readonly string[];
      placeholder?: string;
      onCommit(next: readonly string[]): unknown;
      /** Each saved name's colour, chosen beside it in the editor (a label's theme colour). Absent: names have none. */
      tones?: PropertyNameTones;
      /** Say the saved names as chips instead of joined words (labels), with or without colours. */
      chips?: boolean;
    }>
  | Readonly<{
      kind: 'choice';
      value: string | null;
      choices: readonly PropertyChoice[];
      /** Find choices by their name or supporting identity. */
      searchable?: boolean;
      onCommit(next: string | null): unknown;
    }>
  | Readonly<{
      kind: 'choices';
      value: readonly string[];
      choices: readonly PropertyChoice[];
      /** Find choices by their name or supporting identity. */
      searchable?: boolean;
      /** Say the chosen names as chips instead of joined words (labels). */
      chips?: boolean;
      /** The choices are read from a directory (people): its state is said in the picker. */
      directory?: PropertyChoiceDirectory;
      onCommit(next: readonly string[]): unknown;
    }>;

/** The colours a name can take, by theme tone, and the one change that sets or clears a name's colour. */
export type PropertyNameTones = Readonly<{
  choices: readonly Readonly<{ id: string; label: string; tone: HappierMarkColor }>[];
  valueOf(name: string): string | null;
  onCommit(name: string, choiceId: string | null): unknown;
}>;

export type PropertyListItem = Readonly<{
  /** Stable within the list; also the row's test id suffix. */
  id: string;
  label: string;
  /** The value as people read it. `null` reads as the list's "None". */
  value: string | null;
  /** A mark before the value (a person's `Avatar` beside their name). The value's words stay its accessible name. */
  valueLeading?: ReactNode;
  /** Absent: the property is read-only and its value is plain text. */
  editor?: PropertyEditor;
  /** Whether the value can be set back to "not set". Defaults to true. */
  clearable?: boolean;
  /** The unset choice's name, such as "Unassigned". Defaults to "Clear". */
  clearLabel?: string;
  /** This property's change is being written; its control is held. */
  busy?: boolean;
}>;

export type PropertyListProps = Readonly<{
  items: readonly PropertyListItem[];
  /** Holds every control (an entry being written, a read-only snapshot). Values stay readable. */
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}>;

/** The label column: wide enough for the common property names ("Due date", "Blocked by"), so values share one edge. */
const PROPERTY_LABEL_WIDTH_PX = 96;
const CLEAR_ID = '\u0000clear';
const DIRECTORY_STATUS_ID = '\u0000directory';
const DIRECTORY_RETRY_ID = '\u0000retry';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validCalendarDay(text: string): boolean {
  if (!DATE_PATTERN.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Typed properties of one thing (a task's owner, due date, labels, parent): a quiet label beside a value that is
 * its own control. Pressing a value opens that value's picker, and a change commits that one property, so an edit
 * never saves a whole form and a property the thing does not support is simply not in the list.
 */
export function PropertyList(props: PropertyListProps): ReactElement {
  const theme = usePluginTheme();
  const [stacked, setStacked] = useState(false);
  const onLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const width = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
    if (width !== null) setStacked(isHappierPageRowNarrow(width));
  }, []);
  return (
    <View
      onLayout={onLayout}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      style={{ gap: theme.spacing.xsmall }}
    >
      {props.items.map((item) => (
        <View
          key={item.id}
          testID={
            props.testID === undefined
              ? undefined
              : `${props.testID}.${item.id}`
          }
          style={{
            flexDirection: stacked ? 'column' : 'row',
            alignItems: stacked ? 'stretch' : 'center',
            gap: stacked ? theme.spacing.xsmall : theme.spacing.medium,
            minHeight: theme.spacing.xlarge + theme.spacing.small,
          }}
        >
          <View style={{ ...(stacked ? {} : { width: PROPERTY_LABEL_WIDTH_PX }), flexShrink: 0 }}>
            <Text
              variant="meta"
              tone="secondary"
              value={item.label}
              numberOfLines={1}
            />
          </View>
          <View style={{ ...(stacked ? {} : { flex: 1 }), minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xsmall }}>
            {item.value === null || item.valueLeading === undefined ? null : (
              // Decoration: the value's words already name it, so the mark is not announced a second time.
              <View aria-hidden importantForAccessibility="no-hide-descendants">{item.valueLeading}</View>
            )}
            {/* A value that opens its picker is a quiet button whose words stand on the value edge (its hover slab
                reaches into the gutter), so editable and read-only values read as one column. */}
            <View style={{ flexShrink: 1, minWidth: 0 }}><HappierTextActionEdgeContext.Provider value="start">
              <PropertyValue
                item={item}
                disabled={props.disabled === true || item.busy === true}
                {...(props.testID === undefined
                  ? {}
                  : { testID: `${props.testID}.${item.id}.value` })}
              />
              </HappierTextActionEdgeContext.Provider>
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

function PropertyValue(
  props: Readonly<{
    item: PropertyListItem;
    disabled: boolean;
    testID?: string;
  }>,
): ReactElement {
  const translate = usePluginTranslation();
  const { item } = props;
  const none = translate('happier.plugin-ui.propertyList.none', 'None');
  const shown = item.value ?? none;
  const toneOfValue =
    item.value === null ? ('secondary' as const) : ('neutral' as const);
  const editor = item.editor;
  if (editor === undefined)
    return (
      <Text variant="body" tone={toneOfValue} value={shown} numberOfLines={1} />
    );
  const triggerAccessibilityLabel = `${item.label}, ${shown}`;
  if (editor.kind === 'choice' || editor.kind === 'choices') {
    return (
      <PropertyChoiceMenu
        item={item}
        editor={editor}
        shown={shown}
        toneOfValue={toneOfValue}
        triggerAccessibilityLabel={triggerAccessibilityLabel}
        disabled={props.disabled}
        {...(props.testID === undefined ? {} : { testID: props.testID })}
      />
    );
  }
  return (
    <PropertyFieldPopover
      item={item}
      editor={editor}
      shown={shown}
      toneOfValue={toneOfValue}
      triggerAccessibilityLabel={triggerAccessibilityLabel}
      disabled={props.disabled}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    />
  );
}

type ChoiceEditor = Extract<PropertyEditor, { kind: 'choice' | 'choices' }>;
type FieldEditor = Exclude<PropertyEditor, ChoiceEditor>;

function PropertyChoiceMenu(
  props: Readonly<{
    item: PropertyListItem;
    editor: ChoiceEditor;
    shown: string;
    toneOfValue: 'secondary' | 'neutral';
    triggerAccessibilityLabel: string;
    disabled: boolean;
    testID?: string;
  }>,
): ReactElement {
  const translate = usePluginTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const write = usePropertyCommit();
  const { editor, item } = props;
  const multiple = editor.kind === 'choices';
  const selected = new Set(
    editor.kind === 'choices'
      ? editor.value
      : editor.value === null
        ? []
        : [editor.value],
  );
  const clearable = item.clearable !== false && selected.size > 0;
  const radioGroupId = 'property';
  const directory = editor.kind === 'choices' ? editor.directory : undefined;
  // A directory's state is a line of the picker itself, never a second surface; picking stays the only way in.
  const directoryItems: MenuItem[] = directory === undefined || directory.status === 'ready' ? []
    : directory.status === 'loading'
      ? [{ id: DIRECTORY_STATUS_ID, label: translate('happier.plugin-ui.propertyList.loading', 'Loading\u2026'), disabled: true }]
      : [{ id: DIRECTORY_STATUS_ID, label: directory.unavailableLabel
          ?? translate('happier.plugin-ui.propertyList.unavailable', 'This list couldn\u2019t be loaded'), disabled: true },
        ...(directory.retry === undefined ? [] : [{ id: DIRECTORY_RETRY_ID, label: translate('happier.plugin-ui.propertyList.retry', 'Try again') }])];
  const items: MenuItem[] = [
    ...editor.choices.map((choice): MenuItem => ({
      ...propertyChoiceMenuItem(choice),
      ...(multiple
        ? { kind: 'checkbox' as const, checked: selected.has(choice.id) }
        : { kind: 'radio' as const, radioGroupId }),
    })),
    ...(clearable && !multiple
      ? [
          {
            id: CLEAR_ID,
            label: item.clearLabel ?? translate('happier.plugin-ui.propertyList.clear', 'Clear'),
          },
        ]
      : []),
    ...directoryItems,
  ];
  return (
    <Stack gap="small"><Menu
      open={open && !props.disabled}
      onOpenChange={(next) => {
        if (next && (props.disabled || write.busy)) return;
        setQuery('');
        setOpen(next);
        if (next) directory?.onOpen?.();
      }}
      disabled={props.disabled || write.busy}
      trigger={props.shown}
      triggerTextTone={props.toneOfValue}
      triggerTextVariant="body"
      {...(editor.kind === 'choices' && editor.chips === true && editor.value.length > 0
        ? { triggerContent: <PropertyNameChips names={editor.value.map((id) => editor.choices.find((choice) => choice.id === id)?.label ?? id)} /> }
        : { triggerAppearance: 'status' as const })}
      triggerAccessibilityLabel={props.triggerAccessibilityLabel}
      sheet={{ title: item.label }}
      items={items}
      {...(editor.searchable === true ? { search: { value: query, onValueChange: setQuery } } : {})}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      {...(multiple
        ? {}
        : {
            radioGroups: [
              {
                id: radioGroupId,
                accessibilityLabel: item.label,
                selectedId: editor.kind === 'choice' ? editor.value : null,
              },
            ],
          })}
      onSelect={(id) => {
        if (id === DIRECTORY_STATUS_ID) return;
        if (id === DIRECTORY_RETRY_ID) { directory?.retry?.(); return; }
        if (editor.kind === 'choices') {
          const next = selected.has(id)
            ? editor.value.filter((value) => value !== id)
            : [...editor.value, id];
          void write.commit(() => editor.onCommit(next));
          return;
        }
        if (id === CLEAR_ID) {
          void write.commit(() => editor.onCommit(null));
          return;
        }
        if (id !== editor.value) void write.commit(() => editor.onCommit(id));
      }}
    />{write.notice}</Stack>
  );
}

function fieldDraft(editor: FieldEditor): string {
  if (editor.kind === 'list') return editor.value.join(', ');
  if (editor.kind === 'number')
    return editor.value === null ? '' : String(editor.value);
  return editor.value ?? '';
}

function PropertyFieldPopover(
  props: Readonly<{
    item: PropertyListItem;
    editor: FieldEditor;
    shown: string;
    toneOfValue: 'secondary' | 'neutral';
    triggerAccessibilityLabel: string;
    disabled: boolean;
    testID?: string;
  }>,
): ReactElement {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const { editor, item } = props;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  const write = usePropertyCommit();
  const saving = write.busy;
  const openWith = (next: boolean) => {
    if (next && props.disabled) return;
    if (next) {
      setDraft(fieldDraft(editor));
      setIssue(null);
    }
    if (!saving) setOpen(next);
  };
  const widget = editor.kind === 'text' ? (editor.multiline === true ? 'textarea' as const : 'text' as const)
    : editor.kind === 'number' ? (editor.integer === true ? 'integer' as const : 'number' as const) : 'text' as const;
  const placeholder = editor.kind === 'date' ? 'YYYY-MM-DD'
    : editor.kind === 'list' ? editor.placeholder ?? translate('happier.plugin-ui.propertyList.listPlaceholder', 'Separate names with commas')
      : editor.kind === 'text' ? editor.placeholder : undefined;
  const descriptor: HappierInputFieldDescriptor = { path: item.id, title: item.label, widget, ...(placeholder === undefined ? {} : { placeholder }) };
  const commit = async (next: unknown) => {
    if (await write.commit(() => (editor.onCommit as (value: unknown) => unknown)(next))) setOpen(false);
  };
  const save = () => {
    const text = draft.trim();
    if (editor.kind === 'list') {
      void commit(
        text
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name.length > 0),
      );
      return;
    }
    if (text.length === 0) {
      if (item.clearable === false) {
        setIssue(
          translate(
            'happier.plugin-ui.propertyList.required',
            'This needs a value.',
          ),
        );
        return;
      }
      void commit(null);
      return;
    }
    if (editor.kind === 'number') {
      const value = Number(text);
      if (
        !Number.isFinite(value) ||
        (editor.integer === true && !Number.isInteger(value))
      ) {
        setIssue(
          translate('happier.plugin-ui.propertyList.number', 'Enter a number.'),
        );
        return;
      }
      void commit(value);
      return;
    }
    if (editor.kind === 'date' && !validCalendarDay(text)) {
      setIssue(
        translate(
          'happier.plugin-ui.propertyList.date',
          'Enter a day as YYYY-MM-DD.',
        ),
      );
      return;
    }
    void commit(editor.kind === 'text' ? draft : text);
  };
  const changed = draft !== fieldDraft(editor);
  const saveLabel = translate('happier.plugin-ui.propertyList.save', 'Save');
  return (
    <Popover
      open={open}
      onOpenChange={openWith}
      disabled={props.disabled}
      trigger={props.shown}
      triggerTextTone={props.toneOfValue}
      triggerTextVariant="body"
      {...(editor.kind === 'list' && (editor.tones !== undefined || editor.chips === true) && editor.value.length > 0
        ? { triggerContent: <PropertyNameChips names={editor.value} {...(editor.tones === undefined ? {} : { tones: editor.tones })} /> }
        : { triggerAppearance: 'status' as const })}
      triggerAccessibilityLabel={props.triggerAccessibilityLabel}
      contentAccessibilityLabel={item.label}
      floatingRole="panel"
      sheet={{ title: item.label }}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      <Stack gap="medium">
        {write.notice}
        <HappierInputField
          field={descriptor}
          value={draft}
          onChange={(next) => {
            setDraft(next === undefined || next === null ? '' : String(next));
            setIssue(null);
          }}
          disabled={saving}
          theme={theme}
          {...(issue === null ? {} : { issue })}
          {...(props.testID === undefined
            ? {}
            : { controlTestID: `${props.testID}.input` })}
        />
        {editor.kind === 'list' && editor.tones !== undefined && editor.value.length > 0 ? (
          <Stack gap="xsmall">
            {editor.value.map((name) => (
              <PropertyNameTone key={name} name={name} tones={editor.tones!} disabled={saving} />
            ))}
          </Stack>
        ) : null}
        <HappierFormActions>
          <Row gap="small">
            <Button
              title={saveLabel}
              size="small"
              busy={saving}
              disabled={saving || !changed}
              onPress={save}
              {...(props.testID === undefined
                ? {}
                : { testID: `${props.testID}.save` })}
            />
            <Button
              title={translate(
                'happier.plugin-ui.propertyList.cancel',
                'Cancel',
              )}
              size="small"
              variant="secondary"
              disabled={saving}
              onPress={() => setOpen(false)}
            />
          </Row>
        </HappierFormActions>
      </Stack>
    </Popover>
  );
}

const NO_TONE_ID = '__none__';

/**
 * Coloured names (labels) as chips: each name in neutral words, with its chosen colour as a dot. A name without a
 * colour is a plain chip, the quiet default.
 */
function PropertyNameChips(props: Readonly<{ names: readonly string[]; tones?: PropertyNameTones }>): ReactElement {
  const theme = usePluginTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xsmall }}>
      {props.names.map((name) => {
        const tones = props.tones;
        const tone = tones?.choices.find((choice) => choice.id === tones.valueOf(name))?.tone;
        return <Badge key={name} value={name} {...(tone === undefined ? {} : { dot: tone })} />;
      })}
    </View>
  );
}

/** One saved name with its colour beside it: the tinted tag, the name, and a menu of the colours it can take. */
function PropertyNameTone(
  props: Readonly<{ name: string; tones: PropertyNameTones; disabled: boolean }>,
): ReactElement {
  const translate = usePluginTranslation();
  const [open, setOpen] = useState(false);
  const write = usePropertyCommit();
  const { name, tones } = props;
  const current = tones.choices.find((choice) => choice.id === tones.valueOf(name));
  const none = translate('happier.plugin-ui.propertyList.noColour', 'No colour');
  const shown = current?.label ?? none;
  const groupId = 'tone';
  return (
    <Stack gap="small"><Row gap="small" align="center">
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row' }}>
        <Badge value={name} {...(current === undefined ? {} : { dot: current.tone })} />
      </View>
      <Menu
        open={open && !props.disabled && !write.busy}
        onOpenChange={(next) => setOpen(next && !props.disabled && !write.busy)}
        disabled={props.disabled || write.busy}
        trigger={shown}
        triggerTextTone="secondary"
        triggerAccessibilityLabel={`${translate('happier.plugin-ui.propertyList.colourOf', 'Colour of {name}', { name })}, ${shown}`}
        sheet={{ title: name }}
        items={[
          ...tones.choices.map((choice): MenuItem => ({ id: choice.id, label: choice.label, swatch: choice.tone, kind: 'radio', radioGroupId: groupId })),
          { id: NO_TONE_ID, label: none, kind: 'radio', radioGroupId: groupId },
        ]}
        radioGroups={[{ id: groupId, accessibilityLabel: name, selectedId: current?.id ?? NO_TONE_ID }]}
        onSelect={(id) => {
          setOpen(false);
          const next = id === NO_TONE_ID ? null : id;
          if (next !== (current?.id ?? null)) void write.commit(() => tones.onCommit(name, next));
        }}
      />
    </Row>{write.notice}</Stack>
  );
}

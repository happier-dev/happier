import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover/Popover';
import { t } from '@/text';

import {
  WorkflowSentenceChip,
  WorkflowSentenceUnit,
  WorkflowSentenceWord,
} from '../sentence/WorkflowSentenceChip';
import { workflowSentenceStyles } from '../sentence/workflowSentenceStyles';
import type { WorkflowTriggerStartOption } from './workflowTriggerStarts';

/** One trigger of the workflow, as `WorkflowTriggerSection` already models and writes it. */
export type WorkflowTriggerSentenceLine = Readonly<{
  key: string;
  /** The chosen start's id in the start menu; `null` for a trigger the card lists but does not author. */
  startId: string | null;
  /** The start as a menu names it ("A pull request opens"). */
  startTitle: string;
  /** The trigger's own sentence (`formatTriggerSummary`), when it says more than its start. */
  detail: string | null;
  enabled: boolean;
  /** The When is not complete yet: its detail chip is a placeholder. */
  incomplete: boolean;
  onSelectStart: (id: string) => void;
  onRemove: () => void;
  /** The trigger's own rows from the When card (`WorkflowTriggerBlock`), opened from its detail chip. */
  renderRows: () => React.ReactNode;
}>;

const SENTENCE_POPOVER_MAX_WIDTH_PX = 420;
const REMOVE_ID = 'sentence:remove';

/** "A pull request opens" reads "a pull request opens" after "When"; a name keeps its capitals. */
function lowerStart(text: string): string {
  return /^\p{Lu}\p{Ll}/u.test(text)
    ? text.charAt(0).toLocaleLowerCase() + text.slice(1)
    : text;
}

/**
 * The sentence's When clause (round 1116c): one line per trigger (its start chip and, when it has rows,
 * the chip that opens them), then a quiet "or…" that adds one through the same grouped start menu. With
 * no trigger it reads "When you press Run now" with "or when…". Every chip opens the When card's own
 * picker; `WorkflowTriggerSection` keeps the state and every write.
 */
export function WorkflowTriggerSentenceLines(
  props: Readonly<{
    testIDPrefix: string;
    lines: readonly WorkflowTriggerSentenceLine[];
    startOptions: readonly WorkflowTriggerStartOption[];
    onAdd: (id: string) => void;
    /** A start menu opened or closed: the plugin Event catalog is read while one is open. */
    onStartsOpenChange: (open: boolean) => void;
    /** The menu's foot: where plugin triggers come from. */
    addFooter?: React.ReactNode;
    /** One line under the clause while the triggers could not be read (the card's own line). */
    status?: React.ReactNode;
    editable: boolean;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const items = React.useCallback(
    (currentId: string | null): DropdownMenuItem[] =>
      props.startOptions.map((option) => ({
        id: option.id,
        testID: `${props.testIDPrefix}-sentence-start:${option.id}`,
        title: option.title,
        category: option.group,
        checked: option.id === currentId,
        icon: (
          <Icon
            name={option.glyph}
            size={ICON_SIZE.xs}
            color={theme.colors.text.secondary}
          />
        ),
      })),
    [props.startOptions, props.testIDPrefix, theme.colors.text.secondary],
  );
  const last = props.lines.length - 1;
  return (
    <>
      {props.lines.length === 0 ? (
        <View style={workflowSentenceStyles.line}>
          <WorkflowSentenceWord>
            {t('workflows.triggers.card.manualSentence')}
          </WorkflowSentenceWord>
          {props.editable ? (
            <WorkflowSentenceStartMenu
              testID={`${props.testIDPrefix}-sentence-add-trigger`}
              label={t('workflows.sentence.orWhen')}
              items={items(null)}
              onSelect={props.onAdd}
              onOpenChange={props.onStartsOpenChange}
              footer={props.addFooter}
              sheetTitle={t('workflows.triggers.card.add')}
            />
          ) : null}
        </View>
      ) : (
        props.lines.map((line, index) => (
          <View
            key={line.key}
            style={workflowSentenceStyles.line}
            testID={`${props.testIDPrefix}-sentence-trigger:${line.key}`}
          >
            <WorkflowSentenceUnit
              word={
                index === 0
                  ? t('workflows.sentence.when')
                  : t('workflows.sentence.or')
              }
              rowLabel={
                index === 0
                  ? t('workflows.sentence.rows.when')
                  : t('workflows.sentence.rows.or')
              }
            >
              {line.startId === null || !props.editable ? (
                <WorkflowSentenceChip
                  kind="option"
                  label={lowerStart(line.startTitle)}
                  struck={!line.enabled}
                  disabled
                  onPress={() => {}}
                  testID={`${props.testIDPrefix}-sentence-trigger:${line.key}-start`}
                />
              ) : (
                <WorkflowSentenceStartMenu
                  testID={`${props.testIDPrefix}-sentence-trigger:${line.key}-start`}
                  label={lowerStart(line.startTitle)}
                  kind="option"
                  struck={!line.enabled}
                  selectedId={line.startId}
                  items={[
                    ...items(line.startId),
                    {
                      id: REMOVE_ID,
                      title: t('workflows.sentence.removeTrigger'),
                      // Its own untitled section, last: no heading above "Remove this trigger" (lab `.ft2`).
                      category: '',
                      destructive: true,
                      icon: (
                        <Icon
                          name="trash"
                          size={ICON_SIZE.xs}
                          color={theme.colors.state.danger.foreground}
                        />
                      ),
                      testID: `${props.testIDPrefix}-sentence-trigger:${line.key}-remove`,
                    },
                  ]}
                  onSelect={(id) =>
                    id === REMOVE_ID ? line.onRemove() : line.onSelectStart(id)
                  }
                  onOpenChange={props.onStartsOpenChange}
                  sheetTitle={t('workflows.sentence.changeTrigger')}
                />
              )}
            </WorkflowSentenceUnit>
            {line.detail === null && !line.incomplete ? null : (
              <WorkflowSentenceUnit rowLabel={t('workflows.sentence.rows.details')}>
                <WorkflowSentenceRowsChip
                  testID={`${props.testIDPrefix}-sentence-trigger:${line.key}-detail`}
                  label={
                    line.incomplete
                      ? t('workflows.triggers.card.setUp')
                      : lowerStart(line.detail ?? '')
                  }
                  placeholder={line.incomplete}
                  struck={!line.enabled}
                  title={line.startTitle}
                  renderRows={line.renderRows}
                />
              </WorkflowSentenceUnit>
            )}
            {index === last && props.editable ? (
              <WorkflowSentenceStartMenu
                testID={`${props.testIDPrefix}-sentence-add-trigger`}
                label={t('workflows.sentence.orMore')}
                items={items(null)}
                onSelect={props.onAdd}
                onOpenChange={props.onStartsOpenChange}
                footer={props.addFooter}
                sheetTitle={t('workflows.triggers.card.add')}
              />
            ) : null}
          </View>
        ))
      )}
      {props.status ?? null}
    </>
  );
}

/** A chip that opens the grouped start menu: changing a trigger's start, or adding one ("or…"). */
function WorkflowSentenceStartMenu(
  props: Readonly<{
    testID: string;
    label: string;
    kind?: 'option' | 'add';
    struck?: boolean;
    items: readonly DropdownMenuItem[];
    onSelect: (id: string) => void;
    onOpenChange: (open: boolean) => void;
    footer?: React.ReactNode;
    sheetTitle: string;
    /** The current trigger's start: checked, and the open menu scrolls to it. */
    selectedId?: string | null;
  }>,
) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<View>(null);
  const { onOpenChange } = props;
  const changeOpen = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange(next);
    },
    [onOpenChange],
  );
  const add = (props.kind ?? 'add') === 'add';
  return (
    <DropdownMenu
      testID={`${props.testID}-menu`}
      open={open}
      onOpenChange={changeOpen}
      {...(props.selectedId === undefined ? {} : { selectedId: props.selectedId })}
      items={props.items}
      showCategoryTitles
      search
      searchPlaceholder={t('workflows.triggers.card.searchTriggers')}
      emptyLabel={t('workflows.triggers.card.noTriggersFound')}
      placement="bottom"
      matchTriggerWidth={false}
      popoverPhonePresentation="sheet"
      popoverAccessibilityLabel={props.sheetTitle}
      {...(props.footer === undefined ? {} : { footer: props.footer })}
      onSelect={(id) => {
        changeOpen(false);
        props.onSelect(id);
      }}
      trigger={({ toggle }) => (
        <WorkflowSentenceChip
          anchorRef={anchorRef}
          kind={add ? 'add' : 'option'}
          label={props.label}
          {...(add ? { icon: 'plus' as const, selected: open } : { open })}
          {...(props.struck ? { struck: true } : {})}
          hasPopup="menu"
          onPress={toggle}
          testID={props.testID}
        />
      )}
    />
  );
}

/** A trigger's detail chip: its own When-card rows, in a popover below it (the shared sheet on a phone). */
function WorkflowSentenceRowsChip(
  props: Readonly<{
    testID: string;
    label: string;
    title: string;
    placeholder: boolean;
    struck: boolean;
    renderRows: () => React.ReactNode;
  }>,
) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<View | null>(null);
  const close = React.useCallback(() => setOpen(false), []);
  return (
    <>
      <WorkflowSentenceChip
        anchorRef={anchorRef}
        kind={props.placeholder ? 'placeholder' : 'option'}
        label={props.label}
        title={props.title}
        struck={props.struck}
        open={open}
        hasPopup="dialog"
        onPress={() => setOpen((value) => !value)}
        testID={props.testID}
      />
      {open ? (
        <Popover
          open
          anchorRef={anchorRef}
          placement="bottom"
          phonePresentation="sheet"
          accessibilityLabel={props.title}
          portal={{
            web: { target: 'body' },
            native: true,
            matchAnchorWidth: false,
          }}
          maxWidthCap={SENTENCE_POPOVER_MAX_WIDTH_PX}
          onRequestClose={close}
        >
          {({ maxHeight, maxWidth }) => (
            <FloatingOverlay
              maxHeight={maxHeight}
              surfaceChrome="theme"
              containerStyle={{
                width: Math.min(maxWidth, SENTENCE_POPOVER_MAX_WIDTH_PX),
              }}
            >
              <View style={styles.rows}>{props.renderRows()}</View>
            </FloatingOverlay>
          )}
        </Popover>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  rows: {
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s8,
  },
}));

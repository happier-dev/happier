import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  findWorkflowBlock,
  listWorkflowResultFieldConsumers,
  renameWorkflowResultField,
  updateWorkflowBlock,
  type WorkflowResultFieldConsumer,
} from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import {
  buildWorkflowResultFieldsContract,
  isWorkflowResultFieldNameValid,
  projectWorkflowResultFields,
  WORKFLOW_RESULT_FIELD_TYPES,
  WORKFLOW_RESULT_LIST_ITEM_TYPES,
  type WorkflowResultField,
  type WorkflowResultFieldType,
  type WorkflowResultListItemType,
} from '@happier-dev/protocol/workflows/workflowResultFieldsV1';
import type {
  WorkflowBlock,
  WorkflowResultContract,
} from '@happier-dev/protocol/workflows/workflowV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import {
  ExpandableItem,
  ExpandableItemCaret,
} from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemAddRow } from '@/components/ui/lists/ItemAddRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useDeviceType } from '@/utils/platform/responsive';
import { Modal } from '@/modal';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import { WorkflowFieldSelect } from './WorkflowStepDataEditor';
import {
  formatWorkflowResultFieldType,
  WORKFLOW_RESULT_FIELD_TYPE_LABEL_KEY,
  workflowResultFieldText as rf,
} from '../presentation/workflowValuePresentation';

/**
 * Result → Named fields (04 §6.1, lab `editor-S5`): authors a step's or Wait's
 * result schema through the protocol's named-field projection. Text stays the
 * default; a schema outside the projection stays intact and is only described.
 * Renaming or removing a field that later steps read asks first and repairs
 * through the shared draft operations (`rename_result_field`).
 */

const TYPE_ICON: Readonly<Record<WorkflowResultFieldType, IconName>> = {
  boolean: 'diamond',
  text: 'text-aa',
  number: 'list-numbers',
  choice: 'list-bullets',
  list: 'stack',
};

const TYPE_DESCRIPTION_KEY = {
  boolean: 'describeBoolean',
  text: 'describeText',
  number: 'describeNumber',
  choice: 'describeChoice',
  list: 'describeList',
} as const satisfies Record<WorkflowResultFieldType, string>;
function nextFieldName(fields: readonly WorkflowResultField[]): string {
  const taken = new Set(fields.map((field) => field.name));
  if (!taken.has('field')) return 'field';
  let ordinal = 2;
  while (taken.has(`field${ordinal}`)) ordinal += 1;
  return `field${ordinal}`;
}

function consumerLabel(
  draft: WorkflowEditorDraft,
  consumer: WorkflowResultFieldConsumer,
): string {
  if (!('blockId' in consumer)) return rf('finalOutput');
  const block = findWorkflowBlock(draft, consumer.blockId);
  return block === null ? consumer.blockId : workflowBlockReferenceLabel(block);
}

const styles = StyleSheet.create((theme) => ({
  key: {
    ...Typography.variant('body'),
    ...Typography.mono(),
    color: theme.colors.text.primary,
  },
  // The body starts on the key's line, past the row's leading caret column.
  body: {
    gap: theme.space.s12,
    paddingBottom: theme.space.s8,
    paddingLeft: PAGE_LIST_METRICS.rowLeadingColumnPx + PAGE_LIST_METRICS.rowLeadingGapPx,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    minWidth: 0,
  },
  lineTop: { alignItems: 'flex-start' },
  /** Phone: a wide control moves beneath its label (only a switch stays beside it). */
  lineStacked: {
    gap: theme.space.s4,
    minWidth: 0,
  },
  label: {
    ...Typography.variant('label'),
    color: theme.colors.text.secondary,
    width: 88,
    flexShrink: 0,
  },
  labelTop: { paddingTop: theme.space.s8 },
  labelStacked: {
    ...Typography.variant('label'),
    color: theme.colors.text.secondary,
  },
  control: { flex: 1, minWidth: 0 },
  choices: { flex: 1, minWidth: 0, gap: theme.space.s8 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  choiceText: {
    ...Typography.variant('body'),
    color: theme.colors.text.primary,
    flex: 1,
    minWidth: 0,
  },
  advanced: {
    ...Typography.variant('body'),
    color: theme.colors.text.secondary,
  },
}));

/** A field's name keeps its typed text until the edit ends; only a valid, free name is committed. */
function FieldNameInput(
  props: Readonly<{
    field: WorkflowResultField;
    fields: readonly WorkflowResultField[];
    onCommit: (name: string) => void;
    testID: string;
  }>,
): React.ReactElement {
  const [text, setText] = React.useState(props.field.name);
  React.useEffect(() => setText(props.field.name), [props.field.name]);
  const trimmed = text.trim();
  const error =
    trimmed === props.field.name
      ? null
      : !isWorkflowResultFieldNameValid(trimmed)
        ? rf('nameInvalid')
        : props.fields.some((field) => field.name === trimmed)
          ? rf('nameTaken')
          : null;
  const commit = () => {
    if (error !== null || trimmed === props.field.name) return;
    props.onCommit(trimmed);
  };
  return (
    <FieldTextInput
      testID={props.testID}
      value={text}
      monospace
      autoCapitalize="none"
      accessibilityLabel={rf('name')}
      error={error}
      onChangeText={setText}
      onBlur={commit}
      onSubmitEditing={commit}
    />
  );
}

function ChoiceValues(
  props: Readonly<{
    choices: readonly string[];
    onChange: (choices: readonly string[]) => void;
    testID: string;
  }>,
): React.ReactElement {
  const [draftChoice, setDraftChoice] = React.useState('');
  const commit = () => {
    const value = draftChoice.trim();
    if (value.length === 0) return;
    if (!props.choices.includes(value))
      props.onChange([...props.choices, value]);
    setDraftChoice('');
  };
  return (
    <View style={styles.choices}>
      {props.choices.map((choice) => (
        <View
          key={choice}
          style={styles.choice}
          testID={`${props.testID}-${choice}`}
        >
          <Text style={styles.choiceText} numberOfLines={1}>
            {choice}
          </Text>
          <IconButton
            testID={`${props.testID}-${choice}-remove`}
            iconName="x"
            variant="plain"
            accessibilityLabel={`${t('workflows.editor.remove')} ${choice}`}
            onPress={() =>
              props.onChange(
                props.choices.filter((candidate) => candidate !== choice),
              )
            }
          />
        </View>
      ))}
      <FieldTextInput
        testID={`${props.testID}-new`}
        value={draftChoice}
        placeholder={rf('addChoice')}
        accessibilityLabel={rf('addChoice')}
        error={
          props.choices.length === 0 && draftChoice.trim().length === 0
            ? rf('noChoices')
            : null
        }
        onChangeText={setDraftChoice}
        onSubmitEditing={commit}
        onBlur={commit}
      />
    </View>
  );
}

function FieldRow(
  props: Readonly<{
    field: WorkflowResultField;
    fields: readonly WorkflowResultField[];
    consumers: readonly WorkflowResultFieldConsumer[];
    draft: WorkflowEditorDraft;
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    onChange: (next: WorkflowResultField) => void;
    onRename: (name: string) => void;
    onRemove: () => void;
    editable: boolean;
    last: boolean;
    testID: string;
  }>,
): React.ReactElement {
  const { field } = props;
  const consumers =
    props.consumers.length === 0
      ? undefined
      : rf('usedBy', {
          names: [
            ...new Set(
              props.consumers.map((consumer) =>
                consumerLabel(props.draft, consumer),
              ),
            ),
          ].join(', '),
        });
  const summary = `${formatWorkflowResultFieldType(field)} · ${rf(field.required ? 'required' : 'optional')}`;
  // A phone recomposes: a field's label sits above its control instead of a label column.
  const stacked = useDeviceType() === 'phone';
  const line = stacked ? styles.lineStacked : styles.line;
  const label = stacked ? styles.labelStacked : styles.label;
  return (
    <ExpandableItem
      testID={props.testID}
      expanded={props.expanded}
      onExpandedChange={props.onExpandedChange}
      showDivider={!props.last}
      header={({ headerProps, expanded }) => (
        <Item
          {...headerProps}
          testID={`${props.testID}-header`}
          title={
            <Text style={styles.key} numberOfLines={1}>
              {field.name}
            </Text>
          }
          subtitle={
            field.description === undefined
              ? summary
              : `${summary} · ${field.description}`
          }
          subtitleLines={1}
          {...(consumers === undefined ? {} : { detail: consumers })}
          accessibilityLabel={`${field.name}, ${summary}${consumers === undefined ? '' : `, ${consumers}`}`}
          showChevron={false}
          leftElement={<ExpandableItemCaret expanded={expanded} />}
        />
      )}
    >
      {props.editable ? (
        <SectionContentRow>
          <View style={styles.body}>
            <View style={line}>
              <Text style={label}>{rf('name')}</Text>
              <View style={styles.control}>
                <FieldNameInput
                  field={field}
                  fields={props.fields}
                  onCommit={props.onRename}
                  testID={`${props.testID}-name`}
                />
              </View>
            </View>
            <View style={line}>
              <Text style={label}>{rf('type')}</Text>
              <WorkflowFieldSelect
                testID={`${props.testID}-type`}
                label={rf('type')}
                items={WORKFLOW_RESULT_FIELD_TYPES.map((type) => ({
                  id: type,
                  testID: `${props.testID}-type-${type}`,
                  title: rf(WORKFLOW_RESULT_FIELD_TYPE_LABEL_KEY[type]),
                  subtitle: rf(TYPE_DESCRIPTION_KEY[type]),
                  icon: <TypeGlyph type={type} />,
                }))}
                selectedId={field.type}
                onSelect={(id) => {
                  const type = WORKFLOW_RESULT_FIELD_TYPES.find(
                    (candidate) => candidate === id,
                  );
                  if (type === undefined || type === field.type) return;
                  const {
                    choices: _choices,
                    itemType: _itemType,
                    ...rest
                  } = field;
                  props.onChange({
                    ...rest,
                    type,
                    ...(type === 'choice' ? { choices: [] } : {}),
                    ...(type === 'list' ? { itemType: 'text' as const } : {}),
                  });
                }}
              />
            </View>
            {field.type === 'choice' ? (
              <View style={stacked ? line : [styles.line, styles.lineTop]}>
                <Text style={stacked ? label : [styles.label, styles.labelTop]}>
                  {rf('choices')}
                </Text>
                <ChoiceValues
                  choices={field.choices ?? []}
                  onChange={(choices) => props.onChange({ ...field, choices })}
                  testID={`${props.testID}-choices`}
                />
              </View>
            ) : null}
            {field.type === 'list' ? (
              <View style={line}>
                <Text style={label}>{rf('items')}</Text>
                <WorkflowFieldSelect
                  testID={`${props.testID}-items`}
                  label={rf('items')}
                  items={WORKFLOW_RESULT_LIST_ITEM_TYPES.map((itemType) => ({
                    id: itemType,
                    testID: `${props.testID}-items-${itemType}`,
                    title: rf(WORKFLOW_RESULT_FIELD_TYPE_LABEL_KEY[itemType]),
                  }))}
                  selectedId={field.itemType ?? 'text'}
                  onSelect={(id) => {
                    const itemType = WORKFLOW_RESULT_LIST_ITEM_TYPES.find(
                      (candidate) => candidate === id,
                    );
                    if (itemType !== undefined)
                      props.onChange({ ...field, itemType });
                  }}
                />
              </View>
            ) : null}
            <View style={styles.line}>
              <Text style={stacked ? [label, styles.control] : label}>{rf('required')}</Text>
              <View style={stacked ? null : styles.control}>
                <Switch
                  testID={`${props.testID}-required`}
                  accessibilityLabel={rf('required')}
                  value={field.required}
                  onValueChange={(required) =>
                    props.onChange({ ...field, required })
                  }
                />
              </View>
            </View>
            <View style={line}>
              <Text style={label}>{rf('descriptionLabel')}</Text>
              <View style={styles.control}>
                <FieldTextInput
                  testID={`${props.testID}-description`}
                  value={field.description ?? ''}
                  placeholder={rf('descriptionPlaceholder')}
                  accessibilityLabel={rf('descriptionLabel')}
                  onChangeText={(description) => {
                    const { description: _previous, ...rest } = field;
                    props.onChange(
                      description.length === 0
                        ? rest
                        : { ...rest, description },
                    );
                  }}
                />
              </View>
            </View>
            <View style={styles.line}>
              <IconButton
                testID={`${props.testID}-remove`}
                iconName="trash"
                variant="plain"
                accessibilityLabel={rf('remove')}
                tooltip={rf('remove')}
                onPress={props.onRemove}
              />
            </View>
          </View>
        </SectionContentRow>
      ) : null}
    </ExpandableItem>
  );
}

function TypeGlyph(
  props: Readonly<{ type: WorkflowResultFieldType }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <Icon
      name={TYPE_ICON[props.type]}
      size={ICON_SIZE.sm}
      color={theme.colors.text.secondary}
    />
  );
}

export function WorkflowResultFieldsEditor(
  props: Readonly<{
    draft: WorkflowEditorDraft;
    block: Extract<WorkflowBlock, { kind: 'step' | 'wait' }>;
    onChange: (next: WorkflowEditorDraft) => void;
    editable?: boolean;
    testIDPrefix: string;
  }>,
): React.ReactElement {
  const { draft, block, onChange, testIDPrefix } = props;
  const editable = props.editable !== false;
  const projection = projectWorkflowResultFields(block.result);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const setResult = (result: WorkflowResultContract) =>
    onChange(
      updateWorkflowBlock(draft, block.id, (current) =>
        current.kind === 'step' || current.kind === 'wait'
          ? { ...current, result }
          : current,
      ),
    );
  const fields = projection.kind === 'fields' ? projection.fields : [];
  const closed = projection.kind === 'fields' ? projection.closed : true;
  const writeFields = (next: readonly WorkflowResultField[]) =>
    setResult(buildWorkflowResultFieldsContract(next, { closed }));
  const consumersOf = (name: string) =>
    listWorkflowResultFieldConsumers(draft, block.id, name);
  const toggle = (name: string, open: boolean) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(name);
      else next.delete(name);
      return next;
    });

  if (projection.kind === 'decision' || projection.kind === 'advanced') {
    // A loop's decision contract and an imported advanced schema are read here, never rewritten.
    return (
      <ItemGroup>
        <SectionContentRow testID={`${testIDPrefix}-result-${projection.kind}`}>
          <Text style={styles.advanced}>
            {projection.kind === 'advanced'
              ? rf('advanced')
              : t('workflows.page.inspector.returnsDecision')}
          </Text>
        </SectionContentRow>
      </ItemGroup>
    );
  }

  const addField = () => {
    const name = nextFieldName(fields);
    writeFields([...fields, { name, type: 'text', required: true }]);
    toggle(name, true);
  };

  return (
    <ItemGroup>
      {editable ? (
        <SegmentedChoiceItem<'text' | 'fields'>
          title={rf('returns')}
          value={projection.kind}
          onChange={async (kind) => {
            if (kind === projection.kind) return;
            if (kind === 'fields') {
              const name = nextFieldName([]);
              setResult(
                buildWorkflowResultFieldsContract([
                  { name, type: 'text', required: true },
                ]),
              );
              toggle(name, true);
              return;
            }
            const readers = fields.reduce(
              (count, field) => count + consumersOf(field.name).length,
              0,
            );
            if (
              readers > 0 &&
              !(await Modal.confirm(
                rf('useTextTitle'),
                rf('useTextBody', { count: readers }),
                {
                  confirmText: rf('useText'),
                },
              ))
            )
              return;
            setResult({ kind: 'text' });
          }}
          testIDPrefix={`${testIDPrefix}-result-kind`}
          options={[
            {
              id: 'text',
              label: rf('typeText'),
              description: rf('describeWhole'),
            },
            {
              id: 'fields',
              label: rf('named'),
              description: rf('description'),
            },
          ]}
        />
      ) : null}
      {fields.map((field, index) => (
        <FieldRow
          key={field.name}
          field={field}
          fields={fields}
          consumers={consumersOf(field.name)}
          draft={draft}
          expanded={expanded.has(field.name)}
          onExpandedChange={(open) => toggle(field.name, open)}
          onChange={(next) =>
            writeFields(
              fields.map((candidate) =>
                candidate.name === field.name ? next : candidate,
              ),
            )
          }
          onRename={async (name) => {
            const readers = consumersOf(field.name);
            if (
              readers.length > 0 &&
              !(await Modal.confirm(
                rf('renameTitle', { from: field.name, to: name }),
                rf('renameBody', {
                  names: readers.map((reader) => consumerLabel(draft, reader)).join(', '),
                  to: name,
                }),
                { confirmText: rf('renameEverywhere') },
              ))
            )
              return;
            // One draft command renames the field and repairs every reader (Action parity: rename_result_field).
            onChange(
              renameWorkflowResultField(draft, block.id, field.name, name),
            );
            setExpanded(
              (current) =>
                new Set(
                  [...current].map((open) =>
                    open === field.name ? name : open,
                  ),
                ),
            );
          }}
          onRemove={async () => {
            const readers = consumersOf(field.name);
            if (
              readers.length > 0 &&
              !(await Modal.confirm(
                rf('removeTitle', { field: field.name }),
                rf('removeBody', { count: readers.length }),
                { confirmText: rf('remove'), destructive: true },
              ))
            )
              return;
            writeFields(
              fields.filter((candidate) => candidate.name !== field.name),
            );
          }}
          editable={editable}
          last={index === fields.length - 1 && !editable}
          testID={`${testIDPrefix}-result-field-${field.name}`}
        />
      ))}
      {editable && projection.kind === 'fields' ? (
        <ItemAddRow
          testID={`${testIDPrefix}-result-add-field`}
          title={rf('add')}
          onPress={addField}
          showDivider={false}
        />
      ) : null}
    </ItemGroup>
  );
}

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  RegistryItemSummaryV1,
  RegistryItemV1,
} from '@happier-dev/protocol/registries';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';

import { CapabilityFacts } from '@/components/capabilities/facts/CapabilityFacts';
import {
  useDraftReachRules,
  WhereItsOnControl,
} from '@/components/capabilities/where/WhereItsOnControl';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { ValueRefRowsEditor } from '@/components/ui/forms/valueRefs/ValueRefRowsEditor';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useRegistryItem } from '@/registries/useRegistryItem';
import {
  projectReachOnMachines,
  type ReachMachine,
} from '@/sync/domains/capabilities/reach/useReachProjection';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

import { McpServerMark } from '../identity/McpServerMark';
import {
  buildMcpAddDetailModel,
  seedMcpAddValues,
  type McpAddDetailModel,
  type McpAddField,
  type McpAddValues,
} from './mcpAddModalConfig';
import type { McpAddPlaces } from './useMcpAddPlaces';

/** What the footer needs from the open details: the read item, the model drawn from it, and what the person set. */
export type McpAddDraft = Readonly<{
  item: RegistryItemV1 | null;
  model: McpAddDetailModel | null;
  values: McpAddValues;
  where: ReachRulesChangeV1 | undefined;
}>;

export type McpAddState =
  | Readonly<{ status: 'adding' }>
  | Readonly<{ status: 'added'; serverId: string | null }>
  | Readonly<{ status: 'failed'; error: string }>;

const entriesOf = (
  fields: readonly McpAddField[],
  values: McpAddValues,
): Record<string, ValueRefV1> =>
  Object.fromEntries(
    fields.flatMap((field) => {
      const value = values[field.key];
      return value ? [[field.key, value] as const] : [];
    }),
  );

const RUNS_COPY = {
  remote: 'capabilities.mcpAdd.detail.runsRemote',
  npx: 'capabilities.mcpAdd.detail.runsNpx',
  uvx: 'capabilities.mcpAdd.detail.runsUvx',
  docker: 'capabilities.mcpAdd.detail.runsDocker',
} as const;

/**
 * A registry server's details (lab ma-D / ma-N): who it is, what it needs (the shared value rows over its declared
 * inputs; a key waits for a Saved Secret, with Add key in that picker), Where it's on (pick), what runs where, and
 * what happens next. Reads the item once and hands it, with the person's values, up to the footer.
 */
export function McpAddDetail(
  props: Readonly<{
    testID: string;
    row: RegistryItemSummaryV1;
    sourceTitle: string;
    existing: McpServerCatalogEntryV1 | null;
    state: McpAddState | null;
    scope: AccountSettingsScope | null;
    places: McpAddPlaces;
    onDraft: (draft: McpAddDraft) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const read = useRegistryItem({
    kind: 'mcpServer',
    sourceId: props.row.sourceId,
    itemId: props.row.itemId,
  });
  const server =
    read.item?.payload.kind === 'mcpServer' ? read.item.payload.server : null;
  const model = React.useMemo(
    () => (server ? buildMcpAddDetailModel(server) : null),
    [server],
  );
  const seed = React.useMemo(
    () => (model?.supported ? seedMcpAddValues(model.fields) : {}),
    [model],
  );
  const [edited, setEdited] = React.useState<McpAddValues | null>(null);
  const values = edited ?? seed;
  const draftReach = useDraftReachRules('mcp_server');
  const catalog = useSavedSecretCatalog(
    props.scope ? { scope: props.scope } : undefined,
  );
  const secrets = React.useMemo(
    () => [...catalog.materializedSecrets],
    [catalog.materializedSecrets],
  );

  const { onDraft } = props;
  React.useEffect(() => {
    onDraft({
      item: read.item,
      model,
      values,
      where: draftReach.where,
    });
  }, [draftReach.where, model, onDraft, read.item, values]);

  const projection = React.useMemo(
    () =>
      projectReachOnMachines(
        draftReach.rules,
        props.places.machines as readonly ReachMachine[],
        undefined,
        props.places.workspaceRefs,
      ),
    [draftReach.rules, props.places.machines, props.places.workspaceRefs],
  );

  const setValue = React.useCallback(
    (key: string, value: ValueRefV1) =>
      setEdited((previous) => ({ ...(previous ?? seed), [key]: value })),
    [seed],
  );
  const setGroup = React.useCallback(
    (next: Record<string, ValueRefV1>) =>
      setEdited((previous) => ({ ...(previous ?? seed), ...next })),
    [seed],
  );

  const supported = model?.supported === true ? model : null;
  const envFields =
    supported?.fields.filter((f) => f.presentation === 'env') ?? [];
  const headerFields =
    supported?.fields.filter((f) => f.presentation === 'header') ?? [];
  const textFields =
    supported?.fields.filter((f) => f.presentation === 'text') ?? [];
  // A declared input says what it is for under its own name, once: env and header rows carry it, a text field
  // carries it under its label.
  const descriptionsOf = (fields: readonly McpAddField[]) =>
    Object.fromEntries(
      fields.flatMap((f) => (f.description ? [[f.key, f.description] as const] : [])),
    );
  const hasSecret = supported?.fields.some((f) => f.secret) ?? false;
  const added = props.state?.status === 'added';
  const deprecated = props.row.flags?.deprecated === true;
  const purpose =
    server?.description?.trim() || props.row.description?.trim() || null;

  return (
    <View style={styles.detail}>
      <ItemGroup surface="none">
        <BareSectionContent>
        <View style={styles.head}>
          <View style={styles.title}>
            <McpServerMark
              transport={supported?.transport === 'local' ? 'stdio' : 'http'}
              iconUrl={props.row.iconUrl ?? null}
              size={30}
            />
            <Text
              variant="title"
              emphasis="semiBold"
              style={[styles.titleText, { color: theme.colors.text.primary }]}
              numberOfLines={2}
              testID={`${props.testID}.detail.title`}
            >
              {props.row.title}
            </Text>
          </View>
          {purpose ? (
            <Text
              variant="reading"
              style={{ color: theme.colors.text.secondary }}
            >
              {purpose}
            </Text>
          ) : null}
          <CapabilityFacts
            presentation="row"
            source={{ kind: 'registry', label: props.sourceTitle }}
            extra={[
              ...(supported
                ? [
                    supported.transport === 'local'
                      ? t('capabilities.mcp.local')
                      : t('capabilities.mcp.remote'),
                  ]
                : []),
              ...(props.row.version ? [`v${props.row.version}`] : []),
            ]}
          />
          {props.row.itemId !== props.row.title ? (
          <View style={styles.verified}>
            {props.row.publisher?.verification ? (
              <Icon
                name="shield-check"
                size={ICON_SIZE.xs}
                color={theme.colors.text.secondary}
              />
            ) : null}
            <Text
              variant="meta"
              style={[styles.mono, { color: theme.colors.text.secondary }]}
              numberOfLines={1}
            >
              {props.row.itemId}
            </Text>
          </View>
          ) : null}
          {deprecated ? (
            <Text variant="meta" style={{ color: theme.colors.status.actionRequired }}>
              {t('capabilities.mcpAdd.detail.deprecated')}
            </Text>
          ) : null}
          {read.error && !read.item ? (
            <View style={styles.partial}>
              <Text
                variant="meta"
                style={{ color: theme.colors.status.error, flexShrink: 1 }}
              >
                {t('capabilities.mcpAdd.detail.loadFailed')}
              </Text>
              <RoundButton
                size="small"
                display="secondary"
                title={t('capabilities.mcpAdd.detail.retry')}
                onPress={() => void read.refresh()}
                testID={`${props.testID}.detail.retry`}
              />
            </View>
          ) : null}
          {model && !model.supported ? (
            <Text variant="meta" style={{ color: theme.colors.status.actionRequired }}>
              {t('capabilities.mcpAdd.detail.unsupported')}
            </Text>
          ) : null}
        </View>
        </BareSectionContent>
      </ItemGroup>

      {props.existing === null && supported ? (
        <>
          <ItemGroup
            title={t('capabilities.mcpAdd.detail.needsTitle')}
            {...(supported.fields.length > 0
              ? { description: t('capabilities.mcpAdd.detail.needsBody') }
              : {})}
          >
            {supported.fields.length === 0 ? (
              supported.signIn ? (
                <Item
                  icon={
                    <Icon
                      name="key"
                      size={ICON_SIZE.md}
                      color={theme.colors.text.secondary}
                    />
                  }
                  title={t('capabilities.mcpAdd.detail.signInTitle', {
                    name: props.row.title,
                  })}
                  subtitle={t('capabilities.mcpAdd.detail.signInBody')}
                />
              ) : (
                <SectionContentRow>
                  <Text
                    variant="body"
                    style={{ color: theme.colors.text.secondary }}
                  >
                    {t('capabilities.mcpAdd.detail.nothingNeeded')}
                  </Text>
                </SectionContentRow>
              )
            ) : (
              <SectionContentRow>
                <View style={styles.needs}>
                  {envFields.length > 0 ? (
                    <ValueRefRowsEditor
                      kind="env"
                      declaredNames
                      descriptions={descriptionsOf(envFields)}
                      entries={entriesOf(envFields, values)}
                      onChangeEntries={setGroup}
                      secrets={secrets}
                      scope={props.scope}
                      testIdPrefix={`${props.testID}.env`}
                    />
                  ) : null}
                  {headerFields.length > 0 ? (
                    <ValueRefRowsEditor
                      kind="header"
                      declaredNames
                      descriptions={descriptionsOf(headerFields)}
                      entries={entriesOf(headerFields, values)}
                      onChangeEntries={setGroup}
                      secrets={secrets}
                      scope={props.scope}
                      testIdPrefix={`${props.testID}.header`}
                    />
                  ) : null}
                  {textFields.map((field) => (
                    <TextField
                      key={field.key}
                      field={field}
                      value={values[field.key]}
                      onChange={(value) => setValue(field.key, value)}
                      testID={`${props.testID}.field.${field.key}`}
                    />
                  ))}
                  {hasSecret ? (
                    <View style={styles.hint}>
                      <Icon
                        name="lock"
                        size={ICON_SIZE.xs}
                        color={theme.colors.text.secondary}
                      />
                      <Text
                        variant="meta"
                        style={{
                          color: theme.colors.text.secondary,
                          flexShrink: 1,
                        }}
                      >
                        {t('capabilities.mcpAdd.detail.keySaved')}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </SectionContentRow>
            )}
          </ItemGroup>

          <WhereItsOnControl
            testID={`${props.testID}.detail.where`}
            kind="mcp_server"
            presentation="pick"
            rules={draftReach.rules}
            status="ready"
            projection={projection}
            places={{
              agentIds: props.places.agentIds,
              machines: props.places.placeMachines,
              projects: props.places.projects,
            }}
            agentTakes={props.places.agentTakes}
            onChange={draftReach.onChange}
          />

          {supported.runs !== 'remoteSignIn' ? (
          <ItemGroup title={t('capabilities.mcpAdd.detail.runsTitle')}>
            <Item
              icon={
                <Icon
                  name={supported.transport === 'local' ? 'terminal' : 'globe'}
                  size={ICON_SIZE.md}
                  color={theme.colors.text.secondary}
                />
              }
              title={t(RUNS_COPY[supported.runs as Exclude<typeof supported.runs, 'remoteSignIn'>])}
            />
          </ItemGroup>
          ) : null}

          <ItemGroup title={t('capabilities.mcpAdd.detail.nextTitle')}>
            <SectionContentRow>
            <View style={styles.steps}>
              {[
                hasSecret
                  ? t('capabilities.mcpAdd.detail.nextSavedKey')
                  : t('capabilities.mcpAdd.detail.nextSaved'),
                supported.signIn
                  ? t('capabilities.mcpAdd.detail.nextSignIn')
                  : t('capabilities.mcpAdd.detail.nextSessions'),
                t('capabilities.mcpAdd.detail.nextUntouched'),
              ].map((line, index) => (
                <Text
                  key={line}
                  variant="body"
                  style={{ color: theme.colors.text.primary }}
                >
                  {`${index + 1}. ${line}`}
                </Text>
              ))}
            </View>
            </SectionContentRow>
          </ItemGroup>
        </>
      ) : null}

    </View>
  );
}

/** A value the rows editor can't name (a template variable, an argument): its label and one field or choice. */
function TextField(
  props: Readonly<{
    field: McpAddField;
    value: ValueRefV1 | undefined;
    onChange: (value: ValueRefV1) => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const text = props.value?.t === 'literal' ? props.value.v : '';
  return (
    <View style={styles.textField}>
      <Text variant="label" style={{ color: theme.colors.text.primary }}>
        {props.field.key}
      </Text>
      {props.field.description ? (
        <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
          {props.field.description}
        </Text>
      ) : null}
      {props.field.choices ? (
        <ValueFieldSelect
          testID={props.testID}
          label={props.field.key}
          items={props.field.choices.map((choice) => ({
            id: choice,
            title: choice,
          }))}
          selectedId={text || null}
          onSelect={(choice) => props.onChange({ t: 'literal', v: choice })}
        />
      ) : (
        <FieldTextInput
          testID={props.testID}
          value={text}
          onChangeText={(next) => props.onChange({ t: 'literal', v: next })}
          accessibilityLabel={props.field.key}
          monospace
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  detail: { gap: theme.space.s24 },
  head: { gap: theme.space.s8 },
  title: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s12 },
  titleText: { flexShrink: 1 },
  verified: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
  mono: { ...Typography.mono() },
  partial: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    flexWrap: 'wrap',
  },
  needs: { gap: theme.space.s12 },
  hint: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  textField: { gap: theme.space.s4 },
  steps: { gap: theme.space.s8 },
}));

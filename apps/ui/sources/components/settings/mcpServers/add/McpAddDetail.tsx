import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  RegistryItemV1,
} from '@happier-dev/protocol/registries';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';

import { CapabilityAddDetailAction } from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import {
  WhereItsOnControl,
} from '@/components/capabilities/where/WhereItsOnControl';
import { whereItsOnReach } from '@/components/capabilities/where/whereItsOnPresentation';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { ValueRefRowsEditor } from '@/components/ui/forms/valueRefs/ValueRefRowsEditor';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { CapabilityListingSections } from '@/components/capabilities/add/CapabilityListingSections';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useRegistryItem } from '@/registries/useRegistryItem';
import {
  projectReachOnMachines,
  type ReachMachine,
} from '@/sync/domains/capabilities/reach/useReachProjection';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import {
  buildMcpAddDetailModel,
  buildMcpSuggestionDetailModel,
  isMcpAddSuggestion,
  seedMcpAddValues,
  type McpAddCatalogRow,
  type McpAddDetailModel,
  type McpAddField,
  type McpAddValues,
} from './mcpAddModalConfig';
import type { McpAddPlaces } from './useMcpAddPlaces';

/** What the footer needs from the open details: the read item, the model drawn from it, and what the person set. */
export type McpAddDraft = Readonly<{
  suggestionId?: string;
  item: RegistryItemV1 | null;
  model: McpAddDetailModel | null;
  values: McpAddValues;
  /** Deliberate edits, separate from defaults arriving with the selected read. */
  editedValues?: McpAddValues;
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
 * Memoized: the controller re-renders for every catalog/source arrival, and only this row's own facts redraw it.
 */
export const McpAddDetail = React.memo(function McpAddDetail(
  props: Readonly<{
    testID: string;
    row: McpAddCatalogRow;
    sourceTitle: string | null;
    existing: McpServerCatalogEntryV1 | null;
    state: McpAddState | null;
    scope: AccountSettingsScope | null;
    places: McpAddPlaces;
    draft?: McpAddDraft;
    onDraft: (draft: McpAddDraft) => void;
    onEdit: (update: (current: McpAddDraft) => McpAddDraft) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const suggestion = isMcpAddSuggestion(props.row) ? props.row : null;
  const registryRow = isMcpAddSuggestion(props.row) ? null : props.row;
  // A selected unversioned pointer becomes pinned on its first admitted read.
  // Loading that exact pin must not return the same selection to `latest`.
  const [resolvedVersion, setResolvedVersion] = React.useState(registryRow?.version);
  const version = registryRow?.version ?? resolvedVersion;
  const read = useRegistryItem({
    kind: 'mcpServer',
    sourceId: registryRow?.sourceId ?? '',
    itemId: registryRow?.itemId ?? '',
    ...(version ? { version } : {}),
  }, registryRow !== null);
  const item = registryRow && !read.stale && read.item?.summary.sourceId === registryRow.sourceId
    && read.item.summary.itemId === registryRow.itemId
    && (!version || read.item.summary.version === version) ? read.item : null;
  React.useEffect(() => {
    if (!version && item?.summary.version) setResolvedVersion(item.summary.version);
  }, [version, item?.summary.version]);
  const server =
    item?.payload.kind === 'mcpServer' ? item.payload.server : null;
  const model = React.useMemo(
    () => suggestion ? buildMcpSuggestionDetailModel(suggestion) : server ? buildMcpAddDetailModel(server) : null,
    [server, suggestion],
  );
  const seed = React.useMemo(
    () => (model?.supported ? seedMcpAddValues(model.fields) : {}),
    [model],
  );
  const edited = props.draft?.editedValues ?? null;
  const values = edited ?? seed;
  const [defaultReach] = React.useState(() => whereItsOnReach.createDefault('mcp_server'));
  const where = props.draft?.where;
  const rules = React.useMemo(() => where ? whereItsOnReach.apply(defaultReach, where) : defaultReach, [defaultReach, where]);
  const { onEdit } = props;
  const changeReach = React.useCallback<React.ComponentProps<typeof WhereItsOnControl>['onChange']>(async change => {
    onEdit(current => ({ ...current, where: change }));
    return { ok: true };
  }, [onEdit]);
  const catalog = useSavedSecretCatalog({
    scope: model?.supported && model.fields.length > 0 ? props.scope : null,
  });
  const secrets = React.useMemo(
    () => [...catalog.materializedSecrets],
    [catalog.materializedSecrets],
  );

  const { onDraft } = props;
  React.useEffect(() => {
    onDraft({
      ...(suggestion ? { suggestionId: suggestion.suggestionId } : {}),
      item,
      model,
      values,
      ...(edited === null ? {} : { editedValues: edited }),
      where,
    });
  }, [where, edited, model, onDraft, item, values, suggestion]);

  const projection = React.useMemo(
    () =>
      projectReachOnMachines(
        rules,
        props.places.machines as readonly ReachMachine[],
        undefined,
        props.places.workspaceRefs,
      ),
    [rules, props.places.machines, props.places.workspaceRefs],
  );

  const setValue = React.useCallback(
    (key: string, value: ValueRefV1) =>
      onEdit(current => {
        const values = { ...(current.editedValues ?? seed), [key]: value };
        return { ...current, editedValues: values, values };
      }),
    [onEdit, seed],
  );
  const setGroup = React.useCallback(
    (next: Record<string, ValueRefV1>) =>
      onEdit(current => {
        const values = { ...(current.editedValues ?? seed), ...next };
        return { ...current, editedValues: values, values };
      }),
    [onEdit, seed],
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
  // Where the listing comes from closes its details, as every listing does (lab store `h:kNotion`).
  const listed = item?.summary ?? registryRow;
  const listing = listed ? {
    version: listed.version ?? null,
    sourceTitle: props.sourceTitle,
    license: listed.license ?? null,
    links: listed.links ?? null,
  } : null;

  return (
    <View>
      {/* The listing's identity is the shared listing header (icon row = mark + name; purpose and facts on the
          content edge), so the Add body's placement of it (level with the search) applies here as everywhere. */}
      <CapabilityDetailHeader
        testID={`${props.testID}.detail.header`}
        mark={
          <HappierBrandMark
            brand={props.row.brandMark ?? { displayName: props.row.title }}
            externallyLabelled
            pixelSize={28}
          />
        }
        title={props.row.title}
        {...(purpose ? { purpose } : {})}
        facts={{
          ...(props.sourceTitle ? { source: { kind: 'registry' as const, label: props.sourceTitle } } : {}),
          extra: [
            ...(supported
              ? [
                  supported.transport === 'local'
                    ? t('capabilities.mcp.local')
                    : t('capabilities.mcp.remote'),
                ]
              : []),
            ...(props.row.version ? [`v${props.row.version}`] : []),
          ],
        }}
        {...(props.row.itemId && props.row.itemId !== props.row.title
          ? { mono: props.row.itemId, monoVerified: Boolean(props.row.publisher?.verification) }
          : {})}
      />
      <View style={styles.notes}>
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
      {/* The one action, right under what it adds (lab `m:mcp`); the body supplies it. */}
      <CapabilityAddDetailAction />

      {props.existing === null && !supported && !model && !read.error ? (
        // The item is being read: its sections hold their place, so the body does not arrive blank and then jump.
        <>
          <ItemGroup title={t('capabilities.mcpAdd.detail.needsTitle')}>
            <SkeletonRows rows={2} />
          </ItemGroup>
          <ItemGroup title={t('capabilities.mcpAdd.detail.nextTitle')}>
            <SkeletonRows rows={3} />
          </ItemGroup>
        </>
      ) : null}

      {props.existing === null && supported ? (
        <>
          <ItemGroup
            title={t('capabilities.mcpAdd.detail.needsTitle')}
            {...(supported.fields.length > 0
              ? { description: t('capabilities.mcpAdd.detail.needsBody') }
              : {})}
          >
            {supported.fields.length === 0 ? (
              supported.signIn ? null : (
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
                      commitOnChange
                      inSectionRow
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
                      commitOnChange
                      inSectionRow
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
            {/* The browser sign-in is a need whether or not the server also asks for values (as in a paste). */}
            {supported.signIn ? <McpAddSignInItem name={props.row.title} /> : null}
          </ItemGroup>

          <WhereItsOnControl
            testID={`${props.testID}.detail.where`}
            kind="mcp_server"
            presentation="pick"
            rules={rules}
            status="ready"
            projection={projection}
            places={{
              agentIds: props.places.agentIds,
              machines: props.places.placeMachines,
              projects: props.places.projects,
            }}
            agentTakes={props.places.agentTakes}
            onChange={changeReach}
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

          <McpAddNextSteps savedKey={hasSecret} signIn={supported.signIn} />
        </>
      ) : null}

      {listing ? <CapabilityListingSections testID={`${props.testID}.detail.listing`} facts={listing} /> : null}
    </View>
  );
});

/** The browser sign-in a server asks for after it is saved: shared by the catalog's and a paste's details. */
export function McpAddSignInItem(props: Readonly<{ name: string }>) {
  return (
    <Item
      title={t('capabilities.mcpAdd.detail.signInTitle', { name: props.name })}
      subtitle={t('capabilities.mcpAdd.detail.signInBody')}
    />
  );
}

/** What happens once a server is added: one numbered section, shared by the catalog's and a paste's details. */
export function McpAddNextSteps(props: Readonly<{ savedKey: boolean; signIn: boolean }>) {
  const { theme } = useUnistyles();
  return (
    <ItemGroup title={t('capabilities.mcpAdd.detail.nextTitle')}>
      <SectionContentRow>
        <View style={styles.steps}>
          {[
            props.savedKey
              ? t('capabilities.mcpAdd.detail.nextSavedKey')
              : t('capabilities.mcpAdd.detail.nextSaved'),
            props.signIn
              ? t('capabilities.mcpAdd.detail.nextSignIn')
              : t('capabilities.mcpAdd.detail.nextSessions'),
            t('capabilities.mcpAdd.detail.nextUntouched'),
          ].map((line, index) => (
            <Text key={line} variant="body" style={{ color: theme.colors.text.primary }}>
              {`${index + 1}. ${line}`}
            </Text>
          ))}
        </View>
      </SectionContentRow>
    </ItemGroup>
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
  notes: { gap: theme.space.s8 },
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

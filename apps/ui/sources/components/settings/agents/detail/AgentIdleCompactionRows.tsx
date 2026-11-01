import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  getAgentRuntimeKindsManifest,
  resolveAgentRuntimeControlSurface,
  resolveDefaultAgentRuntimeKind,
  type AgentId,
} from '@happier-dev/agents';
import {
  readAccountSettingValueForBackendTarget,
  resolveIdleCompactionPreference,
} from '@happier-dev/protocol/account/settings/accountSettings';
import type { BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type {
  AgentSessionCompactionCapability,
  AgentSessionCompactionIdleCapability,
} from '@happier-dev/protocol/plugins/agents';
import { PROMPT_CACHE_DURATIONS } from '@happier-dev/protocol/usage/coach/coachVendorFacts';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { useAgentUiSettings } from '@/agents/catalog/useAgentUiSettings';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { useAgentScopedPluginSettingsSnapshot } from '@/agents/registry/useAgentScopedPluginSettingsSnapshot';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveConfiguredAgentRuntimeKindFromUiBehavior } from '@/agents/registry/registryUiBehavior';
import {
  SettingAnchor,
  SettingRow,
} from '@/components/settings/shell/SettingRow';
import {
  SCHEMA_FIELD_INPUT_STYLE,
  SchemaFieldRow,
  SchemaFieldValueSlot,
} from '@/components/settings/schemaFields/SchemaFieldRow';
import { SchemaFieldControl } from '@/components/settings/schemaFields/SchemaFieldControl';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { useSetting } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { formatMachineDuration } from '@/components/machines/durationWords';
import { formatTokenCountLong } from '@/utils/format/usageNumbers';
import { AGENT_SETTINGS } from '../agentsSettings';
import { useAgentPreferenceWriter } from '../useAgentPreferenceWriter';

const MINUTE_MS = 60_000;

/** The documented windows (C7 vendor facts), shortest first; the UI never writes its own list. */
const CACHE_WINDOW_PRESETS_MS: readonly number[] = [
  ...new Set<number>([
    ...Object.values(PROMPT_CACHE_DURATIONS.anthropic),
    ...Object.values(PROMPT_CACHE_DURATIONS.openai),
  ]),
].sort((a, b) => a - b);

type IdleCompactionDeclaration = Readonly<{
  /** What the Agent declares in any runtime mode: whether the switch shows, and its defaults. */
  declared: AgentSessionCompactionIdleCapability;
  /** What the runtime the Agent is configured to start on does; null when that runtime has no idle compaction. */
  configured: AgentSessionCompactionIdleCapability | null;
}>;

/**
 * Bundled Agents publish one descriptor per runtime kind; the configured kind comes from the Agent's
 * own UI behavior. An installed Agent's current projection declares one descriptor for every Session.
 */
export function resolveIdleCompactionDeclaration(
  params: Readonly<{
    bundledAgentId: AgentId | null;
    configuredRuntimeKind: string | null;
    projectedCompaction: AgentSessionCompactionCapability | null | undefined;
  }>,
): IdleCompactionDeclaration | null {
  if (!params.bundledAgentId) {
    const idle = params.projectedCompaction?.idle ?? null;
    return idle ? { declared: idle, configured: idle } : null;
  }
  const agentId = params.bundledAgentId;
  const kinds = Object.keys(
    getAgentRuntimeKindsManifest(agentId)?.byKind ?? {},
  );
  // An Agent whose UI behavior names no configured kind starts on its manifest's default kind.
  const runtimeKind = params.configuredRuntimeKind ?? resolveDefaultAgentRuntimeKind(agentId);
  const configured =
    resolveAgentRuntimeControlSurface(agentId, runtimeKind)
      ?.sessionCapabilities.compaction?.idle ?? null;
  const declared =
    configured ??
    [null, ...kinds]
      .map(
        (kind) =>
          resolveAgentRuntimeControlSurface(agentId, kind)?.sessionCapabilities
            .compaction?.idle ?? null,
      )
      .find((idle) => idle !== null) ??
    null;
  return declared ? { declared, configured } : null;
}

/** Happier-scheduled runtimes honour every refinement; a native one honours the minimum only when it says so. */
function honoursMinimum(
  idle: AgentSessionCompactionIdleCapability | null,
): boolean {
  return (
    idle?.mode === 'host' ||
    (idle?.mode === 'native' && idle.nativeHonorsMinimum === true)
  );
}

/** Digits with the reader's grouping marks; anything else is not a count. */
function parseWholeNumber(text: string): number | null {
  const digits = text.replace(/[\s,.'’  ]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

type IdleCompactionSettingKey =
  | 'sessionIdleCompactionEnabledByTargetKey'
  | 'sessionIdleCompactionMinContextTokensByTargetKey'
  | 'sessionIdleCompactionCacheWindowOverrideMsByTargetKey';

/** The permission row's read: the canonical target first, then its compatibility spellings. */
function readTargetValue<T>(
  map: unknown,
  key: IdleCompactionSettingKey,
  targetKeys: readonly string[],
  accept: (value: unknown) => value is T,
): T | undefined {
  for (const targetKey of targetKeys) {
    const value = readAccountSettingValueForBackendTarget(
      { [key]: map },
      key,
      targetKey as BackendTargetRefV2Input,
    );
    if (accept(value)) return value;
  }
  return undefined;
}
const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean';
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * "Compact while idle" and, while it is on, the "When to compact" disclosure holding the minimum
 * conversation size and the cache window — each only where the configured runtime honours it. The
 * leaf subscribes to its three Account keys and the Agent's declared runtime keys, nothing else.
 */
export const AgentIdleCompactionRows = React.memo(
  function AgentIdleCompactionRows(
    props: Readonly<{
      agentTargetKey: string;
      compatibilityTargetKeys: readonly string[];
      bundledAgentId: AgentId | null;
      projectedCompaction?: AgentSessionCompactionCapability | null;
      accountSettingsAvailable: boolean;
      machineId?: string | null;
      accountScope?: ServerAccountScope | null;
      /** The Account server and current daemon projection the Agent's own plugin settings are read from. */
      accountServerId?: string | null;
      projectionInputs?: DaemonMergedProjectionInputs | null;
      popoverBoundaryRef?: React.ComponentProps<
        typeof DropdownMenu
      >['popoverBoundaryRef'];
    }>,
  ) {
    const runtimeSettings = useAgentUiSettings({
      agentIds: props.bundledAgentId ? [props.bundledAgentId] : [],
      machineId: props.machineId,
      accountScope: props.accountScope,
      domain: 'runtime',
    });
    // The Agent's own runtime choice (e.g. Claude's unified terminal) is a plugin setting: read it
    // through the same snapshot owner the new-session screen uses, then the Agent's UI behavior.
    const pluginSettings = useAgentScopedPluginSettingsSnapshot({
      agentId: props.bundledAgentId,
      projectionInputs: props.projectionInputs,
      serverId: props.accountServerId ?? null,
      machineId: props.machineId,
      accountLifetime: captureActiveServerAccountScopeLifetime(),
      enabled: Boolean(props.bundledAgentId && props.projectionInputs),
    }).snapshot;
    const configuredRuntimeKind = props.bundledAgentId
      ? resolveConfiguredAgentRuntimeKindFromUiBehavior({
          agentId: props.bundledAgentId,
          settings: runtimeSettings,
          pluginSettings,
          machineId: props.machineId,
          accountScope: props.accountScope,
        })
      : null;
    const declaration = React.useMemo(
      () =>
        resolveIdleCompactionDeclaration({
          bundledAgentId: props.bundledAgentId,
          configuredRuntimeKind,
          projectedCompaction: props.projectedCompaction,
        }),
      [configuredRuntimeKind, props.bundledAgentId, props.projectedCompaction],
    );
    const enabledMap = useSetting('sessionIdleCompactionEnabledByTargetKey');
    const minimumMap = useSetting(
      'sessionIdleCompactionMinContextTokensByTargetKey',
    );
    const windowMap = useSetting(
      'sessionIdleCompactionCacheWindowOverrideMsByTargetKey',
    );
    const writePreference = useAgentPreferenceWriter();
    const [whenOpen, setWhenOpen] = React.useState(false);
    if (!declaration) return null;

    const targetKeys = [props.agentTargetKey, ...props.compatibilityTargetKeys];
    const storedMinimum = readTargetValue(
      minimumMap,
      'sessionIdleCompactionMinContextTokensByTargetKey',
      targetKeys,
      isCount,
    );
    const storedWindow = readTargetValue(
      windowMap,
      'sessionIdleCompactionCacheWindowOverrideMsByTargetKey',
      targetKeys,
      isCount,
    );
    const preference = resolveIdleCompactionPreference({
      enabled: readTargetValue(
        enabledMap,
        'sessionIdleCompactionEnabledByTargetKey',
        targetKeys,
        isBoolean,
      ),
      minContextTokens: storedMinimum,
      cacheWindowOverrideMs: storedWindow,
      idle: declaration.configured ?? declaration.declared,
    });
    const showMinimum = honoursMinimum(declaration.configured);
    const showWindow = declaration.configured?.mode === 'host';
    const disabled = !props.accountSettingsAvailable;
    const write = (
      setting:
        | 'idleCompaction'
        | 'idleCompaction.minContextTokens'
        | 'idleCompaction.cacheWindowOverrideMs',
      value: boolean | number | null,
    ) => {
      if (disabled) return;
      void writePreference(setting, props.agentTargetKey, value);
    };
    const setEnabled = (next: boolean) => write('idleCompaction', next);

    const windowLabel =
      preference.cacheWindowOverrideMs === undefined
        ? t('settingsAgents.idleCompaction.cacheWindowAutomatic')
        : formatMachineDuration(preference.cacheWindowOverrideMs);
    const summary = [
      showMinimum
        ? preference.minContextTokens
          ? t('settingsAgents.idleCompaction.whenOverTokens', {
              tokens: formatTokenCountLong(preference.minContextTokens),
            })
          : t('settingsAgents.idleCompaction.whenAnySize')
        : null,
      showWindow ? windowLabel : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' · ');

    return (
      <>
        <SettingRow
          setting={AGENT_SETTINGS.settings.idleCompaction}
          testID="settings.agents.detail.idleCompaction"
          subtitle={t('settingsAgents.idleCompaction.description')}
          subtitleLines={0}
          rightElement={
            <Switch
              testID="settings.agents.detail.idleCompaction.switch"
              value={preference.enabled}
              disabled={disabled}
              accessibilityLabel={t('settingsAgents.idleCompaction.title')}
              onValueChange={setEnabled}
            />
          }
          rightElementOutsidePressable
          showChevron={false}
          disabled={disabled}
          onPress={() => setEnabled(!preference.enabled)}
        />
        {preference.enabled && (showMinimum || showWindow) ? (
          <SettingAnchor
            settings={[
              AGENT_SETTINGS.settings['idleCompaction.minContextTokens'],
              AGENT_SETTINGS.settings['idleCompaction.cacheWindowOverrideMs'],
            ]}
          >
            <ExpandableItem
              testID="settings.agents.detail.idleCompaction.when"
              expanded={whenOpen}
              onExpandedChange={setWhenOpen}
              header={(state) => (
                <Item
                  {...state.headerProps}
                  testID="settings.agents.detail.idleCompaction.when.header"
                  title={t('settingsAgents.idleCompaction.whenTitle')}
                  // Open, the values sit right below; the header doesn't repeat them.
                  detail={state.expanded ? undefined : summary}
                />
              )}
            >
              {showMinimum ? (
                <IdleCompactionMinimumRow
                  stored={storedMinimum}
                  declaredDefault={
                    (declaration.configured ?? declaration.declared)
                      .defaultMinContextTokens
                  }
                  disabled={disabled}
                  onCommit={(value) =>
                    write('idleCompaction.minContextTokens', value)
                  }
                />
              ) : null}
              {showWindow ? (
                <IdleCompactionWindowRow
                  stored={storedWindow}
                  label={windowLabel}
                  disabled={disabled}
                  popoverBoundaryRef={props.popoverBoundaryRef}
                  onCommit={(value) =>
                    write('idleCompaction.cacheWindowOverrideMs', value)
                  }
                />
              ) : null}
            </ExpandableItem>
          </SettingAnchor>
        ) : null}
      </>
    );
  },
);

/**
 * The shared number slot in tokens. Empty shows the declared default as its placeholder; with no
 * default it reads "No minimum" and the unit is hidden. A commit (blur or submit) writes once;
 * clearing the field resets it for this Agent, and anything that is not a count is put back.
 */
const IdleCompactionMinimumRow = React.memo(function IdleCompactionMinimumRow(
  props: Readonly<{
    stored: number | undefined;
    declaredDefault: number | undefined;
    disabled: boolean;
    onCommit: (value: number | null) => void;
  }>,
) {
  const shown =
    props.stored === undefined ? '' : formatTokenCountLong(props.stored);
  const [draft, setDraft] = React.useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() === '') {
      if (props.stored !== undefined) props.onCommit(null);
      return;
    }
    const value = parseWholeNumber(draft);
    if (value !== null && value !== props.stored) props.onCommit(value);
  };
  const title = t('settingsAgents.idleCompaction.minContextTokens');
  const hasDefault = props.declaredDefault !== undefined;
  // "No minimum" reads as a word, never "No minimum tokens": the unit shows only beside a number.
  const unitShown = hasDefault || props.stored !== undefined || (draft ?? '') !== '';
  return (
    <SettingAnchor
      setting={AGENT_SETTINGS.settings['idleCompaction.minContextTokens']}
    >
      <SchemaFieldRow
        testID="settings.agents.detail.idleCompaction.minContextTokens"
        title={title}
        hint={t('settingsAgents.idleCompaction.minContextTokensDescription')}
        layout="adaptive"
        disabled={props.disabled}
        control={
          <SchemaFieldValueSlot
            kind="number"
            unit={
              unitShown ? t('settingsAgents.idleCompaction.tokensUnit') : undefined
            }
          >
            <SchemaFieldControl
              control="text"
              inputProps={{
                testID:
                  'settings.agents.detail.idleCompaction.minContextTokens.input',
                accessibilityLabel: unitShown
                  ? `${title}, ${t('settingsAgents.idleCompaction.tokensUnit')}`
                  : title,
                value: draft ?? shown,
                placeholder: hasDefault
                  ? formatTokenCountLong(props.declaredDefault!)
                  : t('settingsAgents.idleCompaction.minContextTokensNone'),
                keyboardType: 'number-pad',
                editable: !props.disabled,
                onChangeText: setDraft,
                onBlur: commit,
                onSubmitEditing: commit,
                style: SCHEMA_FIELD_INPUT_STYLE,
              }}
            />
          </SchemaFieldValueSlot>
        }
      />
    </SettingAnchor>
  );
});

const AUTOMATIC_ID = 'automatic';
const CUSTOM_ID = 'custom';

/**
 * The bordered field select: Automatic, the documented windows, then Custom… — which makes the row
 * compound, the select sized to its word beside the shared minutes slot (as Model beside its effort).
 * Automatic resets the window for this Agent; a preset or committed minutes write it once.
 */
const IdleCompactionWindowRow = React.memo(function IdleCompactionWindowRow(
  props: Readonly<{
    stored: number | undefined;
    label: string;
    disabled: boolean;
    popoverBoundaryRef?: React.ComponentProps<
      typeof DropdownMenu
    >['popoverBoundaryRef'];
    onCommit: (value: number | null) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const [customDraft, setCustomDraft] = React.useState<string | null>(null);
  const storedIsCustom =
    props.stored !== undefined &&
    !CACHE_WINDOW_PRESETS_MS.includes(props.stored);
  const custom = storedIsCustom || customDraft !== null;
  const selectedId = custom
    ? CUSTOM_ID
    : props.stored === undefined
      ? AUTOMATIC_ID
      : String(props.stored);
  const items = React.useMemo(
    () => [
      {
        id: AUTOMATIC_ID,
        category: 'automatic',
        title: t('settingsAgents.idleCompaction.cacheWindowAutomatic'),
      },
      ...CACHE_WINDOW_PRESETS_MS.map((ms) => ({
        id: String(ms),
        category: 'documented',
        title: formatMachineDuration(ms),
      })),
      {
        id: CUSTOM_ID,
        category: 'custom',
        title: t('settingsAgents.idleCompaction.cacheWindowCustomOption'),
      },
    ],
    [],
  );
  const choose = (id: string) => {
    setOpen(false);
    if (id === CUSTOM_ID) {
      if (!storedIsCustom) setCustomDraft('');
      return;
    }
    setCustomDraft(null);
    const next = id === AUTOMATIC_ID ? null : Number(id);
    if (next !== (props.stored ?? null)) props.onCommit(next);
  };
  const commitMinutes = () => {
    if (customDraft === null) return;
    const minutes = parseWholeNumber(customDraft);
    setCustomDraft(null);
    if (minutes !== null && minutes > 0 && minutes * MINUTE_MS !== props.stored)
      props.onCommit(minutes * MINUTE_MS);
  };
  const title = t('settingsAgents.idleCompaction.cacheWindowOverrideMs');
  const storedMinutes =
    storedIsCustom && props.stored !== undefined
      ? String(Math.round((props.stored / MINUTE_MS) * 100) / 100)
      : '';
  return (
    <SettingAnchor
      setting={AGENT_SETTINGS.settings['idleCompaction.cacheWindowOverrideMs']}
    >
      <Item
        testID="settings.agents.detail.idleCompaction.cacheWindow"
        title={title}
        subtitle={t('settingsAgents.idleCompaction.cacheWindowDescription')}
        subtitleLines={0}
        mode="info"
        accessoryLayout="adaptive"
        // One select stays beside its label like Model; the compound Custom row (select, minutes and
        // unit) is wider than a phone label column allows, so it moves beneath as the lab's phone row.
        fieldAccessory={!custom}
        showChevron={false}
        disabled={props.disabled}
        rightElement={
          <View style={styles.compound}>
            <DropdownMenu
              testID="settings.agents.detail.idleCompaction.cacheWindow.menu"
              open={open}
              onOpenChange={setOpen}
              variant="selectable"
              search={false}
              selectedId={selectedId}
              showCategoryTitles={false}
              separateCategories
              connectToTrigger
              rowKind="item"
              popoverBoundaryRef={props.popoverBoundaryRef}
              popoverPortalWebTarget="body"
              items={items}
              onSelect={choose}
              trigger={({ toggle }) => (
                <HappierPressable
                  testID="settings.agents.detail.idleCompaction.cacheWindow.trigger"
                  accessibilityRole="button"
                  accessibilityLabel={`${title}: ${custom ? t('settingsAgents.idleCompaction.cacheWindowCustom') : props.label}`}
                  disabled={props.disabled}
                  onPress={toggle}
                >
                  {renderDropdownItemTriggerRightElement({
                    detail: custom
                      ? t('settingsAgents.idleCompaction.cacheWindowCustom')
                      : props.label,
                    open,
                    detailColor: theme.colors.text.primary,
                    chevronColor: theme.colors.text.secondary,
                    field: resolveFieldBoxColors(theme),
                    fieldSpan: custom ? 'content' : 'column',
                  })}
                </HappierPressable>
              )}
            />
            {custom ? (
              <SchemaFieldValueSlot
                kind="number"
                unit={t('settingsAgents.idleCompaction.minutesUnit')}
              >
                <FieldTextInput
                  testID="settings.agents.detail.idleCompaction.cacheWindow.minutes"
                  accessibilityLabel={`${title}, ${t('settingsAgents.idleCompaction.minutesUnit')}`}
                  value={customDraft ?? storedMinutes}
                  keyboardType="number-pad"
                  editable={!props.disabled}
                  autoFocus={customDraft === '' && !storedIsCustom}
                  onChangeText={setCustomDraft}
                  onBlur={commitMinutes}
                  onSubmitEditing={commitMinutes}
                  style={SCHEMA_FIELD_INPUT_STYLE}
                />
              </SchemaFieldValueSlot>
            ) : null}
          </View>
        }
      />
    </SettingAnchor>
  );
});

const styles = StyleSheet.create((theme) => ({
  compound: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
  },
}));

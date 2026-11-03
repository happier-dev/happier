import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { resolveHappierChoiceControl } from '@happier-dev/plugin-ui/presentation';
import type { PluginSecretSourceFieldV1 } from '@happier-dev/protocol/plugins/contributions/public-types';

import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import {
  SegmentedTabBar,
  SegmentedValueSelect,
} from '@/components/ui/navigation/SegmentedTabBar';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SavedSecretSourceOption } from '@/sync/api/account/savedSecretCatalogPresentation';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import {
  useSavedSecretVaultPicker,
  type SavedSecretVaultPickerState,
} from '../useSavedSecretVaultPicker';

export type SavedSecretVault = Readonly<{ id: string; name: string }>;
export type SavedSecretVaultItem = Readonly<{
  id: string;
  title: string;
  fieldCount: number;
}>;

/**
 * One vault source's account and vault, read only once the person names the account (Show vaults or
 * Return), so typing never reads the vault. The picker hook owns the read; this keeps the person's
 * choice and uses the returned vault metadata, including vaults without item fields.
 */
export function useSavedSecretVaultChoice(
  input: Readonly<{
    scope: ServerAccountScope | null;
    source: SavedSecretSourceOption | null;
    /** An explicit MachineAdministrationTargetSelector selection, when this source has several installations. */
    machineId?: string | null;
    onApprovalPending?: (registration: ActionApprovalRegistration) => void;
  }>,
) {
  const [account, setAccount] = React.useState('');
  const [committed, setCommitted] = React.useState<string | null>(null);
  const [chosenVaultId, setChosenVaultId] = React.useState<string | null>(null);
  const contribution = input.source?.contribution;
  const machineIds = input.source?.machineIds;
  // A sole installed source identifies its Machine; several installations require the person's selection.
  const machineId = input.machineId === undefined ? (machineIds?.length === 1 ? machineIds[0] : undefined) : input.machineId;
  const query = React.useMemo(
    () =>
      contribution && committed ? { contribution, account: committed, ...(machineId ? { machineId } : {}) } : null,
    [contribution, committed, machineId],
  );
  const picker = useSavedSecretVaultPicker({
    scope: input.scope,
    source: query,
    active: query !== null,
  });
  const onApprovalPending = input.onApprovalPending;
  React.useEffect(() => {
    if (picker.approval) onApprovalPending?.(picker.approval);
  }, [picker.approval, onApprovalPending]);
  const fields = picker.state.fields;
  const vaults = React.useMemo(
    () => (picker.state.vaults ?? []).map(vault => ({ id: vault.id, name: vault.name || vault.id })),
    [picker.state.vaults],
  );
  // The first vault stands chosen until the person picks another; a vault that disappears falls back.
  const vault =
    vaults.find((candidate) => candidate.id === chosenVaultId) ??
    vaults[0] ??
    null;
  const items = React.useMemo(
    () => (vault ? itemsIn(fields, vault.id) : []),
    [fields, vault],
  );
  const commit = React.useCallback(() => {
    const trimmed = account.trim();
    if (!trimmed) return;
    if (trimmed === committed) picker.reload();
    else setCommitted(trimmed);
  }, [account, committed, picker.reload]);
  const changeAccount = React.useCallback((next: string) => {
    setAccount(next);
  }, []);
  // The read answers for the account it was asked about; an edited account waits for Show vaults again.
  const current = committed !== null && committed === account.trim();
  const target =
    current && vault && input.source
      ? {
          contribution: input.source.contribution,
          account: committed,
          vaultId: vault.id,
          ...(machineId ? { machineId } : {}),
        }
      : null;
  return {
    account,
    setAccount: changeAccount,
    commit,
    current,
    state: current ? picker.state : IDLE,
    reload: picker.reload,
    vaults,
    vault,
    setVaultId: setChosenVaultId,
    items,
    target,
    dirty: account.length > 0,
  };
}

const IDLE: SavedSecretVaultPickerState = Object.freeze({
  status: 'idle',
  fields: [],
});

function itemsIn(
  fields: readonly PluginSecretSourceFieldV1[],
  vaultId: string,
): readonly SavedSecretVaultItem[] {
  const byId = new Map<
    string,
    { id: string; title: string; fieldCount: number }
  >();
  for (const field of fields) {
    if (field.vault.id !== vaultId) continue;
    const item = byId.get(field.item.id) ?? {
      id: field.item.id,
      title: field.item.title || field.item.id,
      fieldCount: 0,
    };
    item.fieldCount += 1;
    byId.set(field.item.id, item);
  }
  return [...byId.values()].sort((left, right) =>
    left.title.localeCompare(right.title),
  );
}

export type SavedSecretVaultChoice = ReturnType<
  typeof useSavedSecretVaultChoice
>;

/** What a vault read's failure asks of the person, in the source's own name. */
export function savedSecretVaultRepairCopy(
  provider: string,
  repair: SavedSecretVaultPickerState['repair'] | undefined,
): string {
  if (repair === 'install')
    return t('secretsSettings.vaultInstall', { provider });
  if (repair === 'unlock')
    return t('secretsSettings.vaultUnlock', { provider });
  if (repair === 'configure')
    return t('secretsSettings.vaultConfigure', { provider });
  return t('secretsSettings.vaultFailed', { provider });
}

/**
 * Account, then the vault: the fields every vault flow shares (link existing items, save a new value,
 * move secrets). Each read state says one thing in the place the vault choice will take.
 */
export function SavedSecretVaultFields(
  props: Readonly<{
    choice: SavedSecretVaultChoice;
    provider: string;
    disabled?: boolean;
    testID: string;
  }>,
) {
  const { choice, provider } = props;
  const state = choice.state;
  const tabs = React.useMemo(
    () => choice.vaults.map((vault) => ({ id: vault.id, label: vault.name })),
    [choice.vaults],
  );
  const segmented =
    resolveHappierChoiceControl(
      { kind: 'select', value: choice.vault?.id ?? null, multiple: false },
      tabs,
    ) === 'segmented';
  return (
    <>
      <FieldItem label={t('secretsSettings.linkAccount')}>
        <View style={styles.accountRow}>
          <View style={styles.accountField}>
            <FieldTextInput
              testID={`${props.testID}-account`}
              value={choice.account}
              onChangeText={choice.setAccount}
              onSubmitEditing={choice.commit}
              returnKeyType="search"
              placeholder={t('secretsSettings.linkAccountPlaceholder')}
              accessibilityLabel={t('secretsSettings.linkAccount')}
              autoCapitalize="none"
              editable={!props.disabled}
            />
          </View>
          {!choice.current ? (
            <RoundButton
              testID={`${props.testID}-show`}
              size="normal"
              display="secondary"
              title={t('secretsSettings.vaultShow')}
              disabled={props.disabled || choice.account.trim().length === 0}
              onPress={choice.commit}
            />
          ) : null}
        </View>
      </FieldItem>
      {state.status === 'loading' ? (
        <SurfaceStateCard
          testID={`${props.testID}-loading`}
          kind="loading"
          size="line"
          accessibilitySemantics="status"
          title={t('secretsSettings.vaultLoading', { provider })}
        />
      ) : state.status === 'unavailable' ? (
        <SurfaceStateCard
          testID={`${props.testID}-unavailable`}
          kind="unavailable"
          size="line"
          title={savedSecretVaultRepairCopy(provider, state.repair)}
          diagnosticCode={state.code ?? null}
          action={{ label: t('common.retry'), onPress: choice.reload }}
        />
      ) : state.status === 'empty' ? (
        <SurfaceStateCard
          testID={`${props.testID}-empty`}
          kind="empty"
          size="line"
          title={t('secretsSettings.vaultEmpty', { provider })}
        />
      ) : state.status === 'ready' && choice.vault ? (
        <FieldItem label={t('secretsSettings.vaultTitle')}>
          {tabs.length === 1 ? (
            <Text testID={`${props.testID}-vault-only`} variant="body">
                {choice.vault.name}
              </Text>
          ) : segmented ? (
            <SegmentedTabBar
              labelSize="field"
              tabs={tabs}
              activeTabId={choice.vault.id}
              onSelectTab={choice.setVaultId}
              disabled={props.disabled}
              testIDPrefix={`${props.testID}-vault`}
            />
          ) : (
            <SegmentedValueSelect
              tabs={tabs}
              activeTabId={choice.vault.id}
              onSelectTab={choice.setVaultId}
              disabled={props.disabled === true}
              accessibilityLabel={t('secretsSettings.vaultTitle')}
              testID={`${props.testID}-vault`}
            />
          )}
        </FieldItem>
      ) : null}
    </>
  );
}


/** `all` links the whole vault (one secret per field); otherwise the chosen item ids. */
export type SavedSecretVaultItemSelection = 'all' | ReadonlySet<string>;

/**
 * The vault's items as a checklist under one "All items" row, whose mark is mixed while only some are
 * chosen. Everything starts chosen: linking a vault is the common case, trimming it the rare one.
 */
export function SavedSecretVaultItemsField(
  props: Readonly<{
    vault: SavedSecretVault;
    items: readonly SavedSecretVaultItem[];
    selection: SavedSecretVaultItemSelection;
    onChange: (next: SavedSecretVaultItemSelection) => void;
    disabled?: boolean;
    testID: string;
  }>,
) {
  const { items, selection } = props;
  const chosen = (id: string) => selection === 'all' || selection.has(id);
  const count = selection === 'all' ? items.length : selection.size;
  const allState =
    count === items.length ? 'checked' : count === 0 ? 'unchecked' : 'mixed';
  const toggle = (id: string) => {
    const next = new Set(
      selection === 'all' ? items.map((item) => item.id) : selection,
    );
    if (next.has(id)) next.delete(id);
    else next.add(id);
    props.onChange(next.size === items.length ? 'all' : next);
  };
  return (
    <FieldItem label={t('secretsSettings.vaultItemsTitle')}>
      <View style={styles.items} testID={props.testID}>
        <Item
          testID={`${props.testID}-all`}
          title={t('secretsSettings.vaultAllItems', {
            vault: props.vault.name,
          })}
          subtitle={t('secretsSettings.vaultItemsDescription')}
          subtitleLines={0}
          detail={t('secretsSettings.vaultItemCount', { count: items.length })}
          icon={<SelectionCheckGlyph state={allState} />}
          accessibilityRole="checkbox"
          accessibilityChecked={allState === 'checked'}
          showChevron={false}
          disabled={props.disabled}
          onPress={() =>
            props.onChange(allState === 'checked' ? new Set() : 'all')
          }
        />
        {items.map((item) => (
          <Item
            key={item.id}
            testID={`${props.testID}-item:${item.id}`}
            title={item.title}
            // One line per item; how many secrets it becomes sits in the meta column.
            density="compact"
            detail={t('secretsSettings.vaultFieldCount', {
              count: item.fieldCount,
            })}
            icon={
              <SelectionCheckGlyph
                state={chosen(item.id) ? 'checked' : 'unchecked'}
              />
            }
            accessibilityRole="checkbox"
            accessibilityChecked={chosen(item.id)}
            showChevron={false}
            disabled={props.disabled}
            onPress={() => toggle(item.id)}
          />
        ))}
      </View>
    </FieldItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  accountField: { flex: 1, minWidth: 0 },
  items: { width: '100%' },
}));

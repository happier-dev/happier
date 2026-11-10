import * as React from 'react';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

import { useMachineSetupRecipeOptions } from '@/components/store/catalog/storeSoftware';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

import { MachineSetupChangeGroupRow } from './MachineSetupChangeGroupRow';
import { groupMachineSetupItems, machineSetupItemPresentation } from './machineSetupItems';
import { machineSetupScriptCommandLines } from './machineSetupReviewChanges';
import { describeMachineSetup, machineSetupItemReadRow, MACHINE_SETUP_ITEM_GROUP_TITLE } from './MachineSetupSection';
import { ManagedSectionCount } from './ManagedSectionCount';

/**
 * What a preset puts on every Machine it sets up, read-only (lab `p/editor` "Sets it up"): its items by kind in
 * apply order, the same rows the editor shows, with the tools, the setup script's exact commands and the secrets
 * it hands over closing Setup. Nothing for an empty setup unless `onEdit` can add to it.
 */
export function MachineSetupContents(
  props: Readonly<{
    setup: MachineSetupV1 | undefined;
    /** The Account whose recipe declarations name the recipe items. */
    scope: AccountSettingsScope | null;
    onEdit?: () => void;
    testID: string;
  }>,
) {
  const items = props.setup?.items ?? [];
  const groups = groupMachineSetupItems(items);
  const target = React.useMemo(() => props.scope ? { scope: props.scope, machine: null } : null, [props.scope]);
  const recipeOptions = useMachineSetupRecipeOptions(target, { presented: items.some((item) => item.kind !== 'app') });
  const offers = recipeOptions.state.status === 'ready' ? recipeOptions.state.options : null;
  // The script's lines are shown as commands below; the item count is the rows themselves.
  const facts = describeMachineSetup(props.setup).filter((fact) => fact.id !== 'setup-items' && fact.id !== 'setup-script');
  const commandLines = machineSetupScriptCommandLines(props.setup?.scripts);
  const setupExtras = facts.length + (commandLines.length ? 1 : 0);
  const total = items.length + setupExtras;
  if (total === 0 && !props.onEdit) return null;
  const setupGroups = setupExtras && !groups.some((group) => group.kind === 'setupRecipe')
    ? [{ kind: 'setupRecipe' as const, rows: [] }, ...groups] : groups;
  return (
    <>
      {/* The total and the apply order speak only across several kinds; one kind's own heading already counts it. */}
      <ItemGroup testID={props.testID} title={t('machinePresets.setup.itemsTitle')}
        titleAccessory={setupGroups.length > 1 ? <ManagedSectionCount count={total} /> : undefined}
        description={total === 0 ? t('machinePresets.setup.itemsEmpty') : setupGroups.length > 1 ? t('machinePresets.setup.itemsOrder') : undefined}
        action={props.onEdit ? <SectionActionButton testID={`${props.testID}.edit`} icon="pencil-simple"
          title={t('machinePresets.editSetup')} onPress={props.onEdit} /> : undefined}
        surface="none">{null}</ItemGroup>
      {setupGroups.map((group) => {
        const extras = group.kind === 'setupRecipe' ? setupExtras : 0;
        return (
          <ItemGroup key={group.kind} testID={`${props.testID}.${group.kind}`} title={t(MACHINE_SETUP_ITEM_GROUP_TITLE[group.kind])}
            titleAccessory={<ManagedSectionCount count={group.rows.length + extras} />}>
            {group.rows.map(({ item, index }) => {
              const read = machineSetupItemReadRow(item, machineSetupItemPresentation(item, offers));
              return <Item key={`${item.kind}:${index}:${read.title}`} testID={`${props.testID}.item.${index}`} {...read}
                subtitleLines={0} mode="info" showChevron={false} />;
            })}
            {extras ? facts.map((fact) => <Item key={fact.id} testID={`${props.testID}.${fact.id}`} title={fact.label}
              subtitle={fact.value} subtitleLines={0} mode="info" showChevron={false} />) : null}
            {extras && commandLines.length ? <MachineSetupChangeGroupRow testID={`${props.testID}.script`} targetCount={0}
              nameOf={String} group={{ kind: 'commands', lines: commandLines, added: commandLines.length, removed: 0 }} /> : null}
          </ItemGroup>
        );
      })}
    </>
  );
}

import { act } from 'react';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';

/**
 * The list toolbar's pickers and its overflow are shared `Dropdown`/`Menu`/
 * `Select` menus. A semantic mount made with the RNW adapter's `overlays`
 * option presents an open menu inline, so a test reaches a row the way a
 * reader does: press the trigger, then the row.
 *
 * A trigger is named by its field ("Views", "State", "Order", "More") and, when
 * it has one, its current choice after a colon ("Views: Triage queue"); the
 * prefix match keeps a test independent of which choice is current.
 */
export async function openToolbarMenu(shell: PluginUiTestkit, field: string): Promise<void> {
  const triggers = await shell.getAllByRole('button');
  const trigger = triggers.find((candidate) => (
    candidate.name === field || candidate.name?.startsWith(`${field}:`) === true
  ));
  if (trigger === undefined) throw new Error(`No toolbar menu trigger named ${field}`);
  // An already open menu stays open; pressing its trigger again would close it.
  if (trigger.state?.expanded === true) return;
  await act(async () => { await shell.press(trigger); });
}

/** Open a toolbar menu and press one of its rows. */
export async function pressToolbarMenuItem(
  shell: PluginUiTestkit,
  field: string,
  role: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox',
  name: string,
): Promise<void> {
  await openToolbarMenu(shell, field);
  const item = await shell.getByRole(role, { name });
  await act(async () => { await shell.press(item); });
}

/** Open a toolbar menu and find one of its rows (the rest of the query is the testkit's). */
export async function toolbarMenuItem(
  shell: PluginUiTestkit,
  field: string,
  role: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox',
  options: Parameters<PluginUiTestkit['getByRole']>[1],
): Promise<Awaited<ReturnType<PluginUiTestkit['getByRole']>>> {
  await openToolbarMenu(shell, field);
  return await shell.getByRole(role, options);
}

/**
 * The lens facets (Source, Type, Scope, State, Attention) live behind the one **Filters** trigger. On a wide page it
 * opens the shared condition editor: reach a facet's values the way a reader does — its row's values when the facet
 * already narrows the list, else Add filter and the facet — and find the option as the checkbox the editor draws. A
 * phone's folded Filters opens the same editor in the shared sheet. Option names are unique across the facets these
 * fixtures plan.
 */
export async function filterFacetOption(
  shell: PluginUiTestkit,
  facet: string,
  options: Parameters<PluginUiTestkit['getByRole']>[1],
): Promise<Awaited<ReturnType<PluginUiTestkit['getByRole']>>> {
  await openToolbarMenu(shell, 'Filters');
  const name = options?.name;
  const buttons = async () => await shell.getAllByRole('button');
  const values = await shell.queryByRole('checkbox', name === undefined ? {} : { name });
  if (values === undefined) {
    const back = (await buttons()).find((candidate) => candidate.name === 'Back');
    if (back !== undefined) await act(async () => { await shell.press(back); });
    const row = (await buttons()).find((candidate) => candidate.name?.startsWith(`${facet}: `) === true);
    if (row !== undefined) {
      await act(async () => { await shell.press(row); });
    } else {
      await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Add filter' })); });
      await act(async () => { await shell.press(await shell.getByRole('button', { name: facet })); });
    }
  }
  return await shell.getByRole('checkbox', options);
}

/** Open the Filters form and press one facet option. */
export async function pressFilterFacetOption(shell: PluginUiTestkit, facet: string, name: string): Promise<void> {
  const option = await filterFacetOption(shell, facet, { name });
  await act(async () => { await shell.press(option); });
}

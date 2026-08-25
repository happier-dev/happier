import * as React from 'react';
import { View } from 'react-native';
import type { LaunchProfileV2 } from '@happier-dev/protocol';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

/**
 * Where a profile's Sessions run, and how they obtain a checkout.
 *
 * `LaunchProfileV2` has owned `placement` and `checkout` since launch placement
 * landed, and every press already resolves them — but no editor could write
 * one, so they were schema a person could not reach. This is the writer, at the
 * canonical Launch Profile editor rather than in any one consumer: a Triage
 * action, an automation and a plain New Session all read the same preference,
 * so a Triage-only placement control would have been a second owner of the
 * same concept.
 *
 * Both stay PREFERENCES. `automatic` resolves against the project registry at
 * launch, `ask` always prefills the New Session screen, and `fixed` names one
 * execution target — never a stored resolution, never a worktree identity.
 *
 * A pin can only name the machine this editor is actually open against, because
 * a machine picker here would be a second one beside the New Session screen's.
 * A pin the profile already holds for another machine is kept and shown as
 * held: opening the editor to change the checkout must not silently repoint
 * where a person's Sessions run.
 */

type PlacementPreference = LaunchProfileV2['placement'];
type CheckoutPreference = LaunchProfileV2['checkout'];

const NONE = '__none__';
const AUTOMATIC = 'automatic';
const ASK = 'ask';
const FIXED = 'fixed';

export function readSlimProfilePlacementSelectionV1(placement: PlacementPreference): string {
    if (placement === undefined) return NONE;
    if (placement === 'automatic' || placement === 'ask') return placement;
    return FIXED;
}

/**
 * The next placement for one selection, given what the profile already holds
 * and the machine this editor is open against.
 *
 * `fixed` is answered from the held pin FIRST: re-selecting "this machine" on a
 * profile pinned elsewhere while the editor has no machine of its own must keep
 * the pin rather than drop it, and dropping the directory a person typed
 * because they toggled away and back would lose configuration silently.
 */
export function nextSlimProfilePlacementV1(
    selection: string,
    held: PlacementPreference,
    target: Readonly<{ serverId: string; machineId: string }> | null,
): PlacementPreference {
    if (selection === AUTOMATIC || selection === ASK) return selection;
    if (selection !== FIXED) return undefined;
    const heldFixed = held !== undefined && held !== 'automatic' && held !== 'ask' ? held : null;
    if (heldFixed !== null) return heldFixed;
    return target === null ? undefined : { fixed: target };
}

export function withSlimProfilePlacementDirectoryV1(
    held: PlacementPreference,
    directory: string,
): PlacementPreference {
    if (held === undefined || held === 'automatic' || held === 'ask') return held;
    const trimmed = directory.trim();
    return trimmed.length === 0
        ? { fixed: held.fixed }
        : { fixed: held.fixed, directory: trimmed };
}

export function SlimProfilePlacementFields(props: Readonly<{
    machineId: string | null;
    serverId: string | null;
    placement: PlacementPreference;
    checkout: CheckoutPreference;
    onPlacementChange: (value: PlacementPreference) => void;
    onCheckoutChange: (value: CheckoutPreference) => void;
}>) {
    const [placementOpen, setPlacementOpen] = React.useState(false);
    const [checkoutOpen, setCheckoutOpen] = React.useState(false);
    const target = props.machineId !== null && props.serverId !== null
        ? { serverId: props.serverId, machineId: props.machineId }
        : null;
    const selection = readSlimProfilePlacementSelectionV1(props.placement);
    const pinned = props.placement !== undefined
        && props.placement !== 'automatic'
        && props.placement !== 'ask'
        ? props.placement
        : null;

    const placementItems = [
        { id: NONE, title: t('profiles.launchPlacement.none') },
        { id: AUTOMATIC, title: t('profiles.launchPlacement.automatic') },
        { id: ASK, title: t('profiles.launchPlacement.ask') },
        // Offered when this editor can name a machine, and also when the
        // profile already names one — otherwise a held pin would have no row to
        // show as selected and would read as "no preference".
        ...(target !== null || pinned !== null
            ? [{ id: FIXED, title: t('profiles.launchPlacement.fixed') }]
            : []),
    ];

    const checkoutItems = [
        { id: NONE, title: t('profiles.launchCheckout.none') },
        { id: 'reuse_workspace', title: t('profiles.launchCheckout.reuseWorkspace') },
        { id: 'create_worktree', title: t('profiles.launchCheckout.createWorktree') },
        { id: 'ask', title: t('profiles.launchCheckout.ask') },
    ];

    return <>
        <ItemGroup
            title={t('profiles.launchPlacement.title')}
            footer={t('profiles.launchPlacement.footer')}
        >
            <DropdownMenu
                open={placementOpen}
                onOpenChange={setPlacementOpen}
                variant="selectable"
                showCategoryTitles={false}
                rowKind="item"
                selectedId={selection}
                itemTrigger={{
                    title: t('profiles.launchPlacement.title'),
                    showSelectedDetail: false,
                    showSelectedSubtitle: false,
                }}
                items={placementItems}
                onSelect={(id) => {
                    props.onPlacementChange(nextSlimProfilePlacementV1(id, props.placement, target));
                }}
            />
            {pinned === null ? null : (
                <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                    <MachineSetupTextField
                        testID="profile-slim-placement-directory"
                        label={t('profiles.launchPlacement.directory')}
                        value={pinned.directory ?? ''}
                        placeholder={t('profiles.launchPlacement.directoryPlaceholder')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        onChangeText={(directory) => {
                            props.onPlacementChange(
                                withSlimProfilePlacementDirectoryV1(props.placement, directory),
                            );
                        }}
                    />
                </View>
            )}
        </ItemGroup>

        <ItemGroup
            title={t('profiles.launchCheckout.title')}
            footer={t('profiles.launchCheckout.footer')}
        >
            <DropdownMenu
                open={checkoutOpen}
                onOpenChange={setCheckoutOpen}
                variant="selectable"
                showCategoryTitles={false}
                rowKind="item"
                selectedId={props.checkout ?? NONE}
                itemTrigger={{
                    title: t('profiles.launchCheckout.title'),
                    showSelectedDetail: false,
                    showSelectedSubtitle: false,
                }}
                items={checkoutItems}
                onSelect={(id) => {
                    props.onCheckoutChange(
                        id === 'reuse_workspace' || id === 'create_worktree' || id === 'ask'
                            ? id
                            : undefined,
                    );
                }}
            />
        </ItemGroup>
    </>;
}

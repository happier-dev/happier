import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { Modal } from '@/modal';
import { t } from '@/text';

import type { AgentDefaultChoice } from './agentDefaultChoices';

/**
 * ★ "Default for <agent>" (lab `csvc` D1, PL): a menu of the agents that sign in through this
 * service, checked where this account or pool is the agent's default. Choosing one makes it that
 * agent's default; choosing a checked one returns the agent to its own login. Nothing when no agent
 * signs in through the service.
 */
export const AgentDefaultMenuButton = React.memo(function AgentDefaultMenuButton(props: Readonly<{
    choices: readonly AgentDefaultChoice[];
    onChange: (agentId: string, makeDefault: boolean) => void | Promise<void>;
    /** Unread catalogs remain visible but never imply that no default exists. */
    disabledReason?: string;
    /** `icon`: bare ★ in a collection; `text`: quiet identity-line control on a compact entity page. */
    presentation?: 'button' | 'icon' | 'text';
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const [intent, setIntent] = React.useState<Readonly<Record<string, boolean>>>({});
    const changes = React.useRef(new Map<string, { confirmed: boolean; desired: boolean }>());
    const writing = React.useRef(false);
    const mountedRef = useMountedRef();
    const { choices, onChange } = props;
    const displayedChoices = React.useMemo(() => choices.map(choice => Object.hasOwn(intent, choice.agentId)
        ? { ...choice, isDefault: intent[choice.agentId] } : choice), [choices, intent]);
    const defaults = displayedChoices.filter((choice) => choice.isDefault);
    const items = React.useMemo<DropdownMenuItem[]>(() => displayedChoices.map((choice) => ({
        id: choice.agentId,
        testID: props.testID ? `${props.testID}:agent:${choice.agentId}` : undefined,
        title: choice.title,
        rightElement: choice.isDefault ? <Icon name="check" size={16} color={theme.colors.accent.blue} /> : null,
    })), [displayedChoices, props.testID, theme.colors.accent.blue]);
    if (choices.length === 0 && !props.disabledReason) return null;
    const disabledReason = props.disabledReason;
    const disabled = Boolean(disabledReason);
    // The label always says what the control does; why it is waiting is its hint, so a reload never reshapes the header.
    const title = defaults.length === 0
        ? t('connectedServicesPool.makeDefault')
        : defaults.length === 1
            ? t('connectedServicesPool.defaultFor', { agent: defaults[0].title })
            : t('connectedServicesPool.defaultForMore', { agent: defaults[0].title, count: defaults.length - 1 });
    return (
        <DropdownMenu
            open={open}
            onOpenChange={(next) => { if (!next || !disabled) setOpen(next); }}
            items={items}
            selectedId={null}
            onSelect={async (agentId) => {
                if (props.disabledReason) return;
                const choice = choices.find((candidate) => candidate.agentId === agentId);
                if (!choice) return;
                const change = changes.current.get(agentId) ?? { confirmed: choice.isDefault, desired: choice.isDefault };
                change.desired = !change.desired;
                changes.current.set(agentId, change);
                setIntent(previous => ({ ...previous, [agentId]: change.desired }));
                setOpen(false);
                if (writing.current) return;
                writing.current = true;
                try {
                    for (const [id, next] of changes.current) {
                        while (next.desired !== next.confirmed) {
                            const sent = next.desired;
                            try { await onChange(id, sent); next.confirmed = sent; }
                            catch {
                                next.desired = next.confirmed;
                                if (mountedRef.current) Modal.alert(t('common.error'), t('common.unavailable'));
                            }
                        }
                        changes.current.delete(id);
                        if (mountedRef.current) setIntent(previous => {
                            const remaining = { ...previous };
                            delete remaining[id];
                            return remaining;
                        });
                    }
                } finally { writing.current = false; }
            }}
            variant="selectable"
            rowKind="item"
            showCategoryTitles={false}
            placement="bottom"
            popoverAnchorAlign="end"
            trigger={({ toggle }) => props.presentation === 'icon' ? (
                <IconButton
                    testID={props.testID}
                    icon={(
                        <Icon
                            name="star"
                            size={15}
                            weight={defaults.length > 0 ? 'fill' : 'regular'}
                            color={defaults.length > 0 ? theme.colors.text.primary : theme.colors.text.tertiary}
                        />
                    )}
                    size={28}
                    variant="plain"
                    accessibilityLabel={defaults.length === 0 ? t('connectedServicesPool.makeDefaultA11y') : title}
                    disabled={disabled}
                    disabledReason={disabledReason}
                    tooltip={title}
                    onPress={toggle}
                />
            ) : (
                <RoundButton
                    testID={props.testID}
                    size="small"
                    display={props.presentation === 'text' ? 'inverted' : 'secondary'}
                    title={title}
                    accessibilityLabel={defaults.length === 0 ? t('connectedServicesPool.makeDefaultA11y') : title}
                    accessibilityHint={disabledReason}
                    disabled={disabled}
                    leading={props.presentation === 'text' ? undefined : (
                        <Icon
                            name="star"
                            size={14}
                            weight={defaults.length > 0 ? 'fill' : 'regular'}
                            color={theme.colors.text.primary}
                        />
                    )}
                    onPress={toggle}
                />
            )}
        />
    );
});

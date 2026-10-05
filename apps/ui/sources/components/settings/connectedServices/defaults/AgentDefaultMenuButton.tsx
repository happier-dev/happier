import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
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
    onChange: (agentId: string, makeDefault: boolean) => void;
    /** `icon`: bare ★ in a collection; `text`: quiet identity-line control on a compact entity page. */
    presentation?: 'button' | 'icon' | 'text';
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const { choices, onChange } = props;
    const defaults = choices.filter((choice) => choice.isDefault);
    const items = React.useMemo<DropdownMenuItem[]>(() => choices.map((choice) => ({
        id: choice.agentId,
        testID: props.testID ? `${props.testID}:agent:${choice.agentId}` : undefined,
        title: choice.title,
        rightElement: choice.isDefault ? <Icon name="check" size={16} color={theme.colors.accent.blue} /> : null,
    })), [choices, props.testID, theme.colors.accent.blue]);
    if (choices.length === 0) return null;
    const title = defaults.length === 0
        ? t('connectedServicesPool.makeDefault')
        : defaults.length === 1
            ? t('connectedServicesPool.defaultFor', { agent: defaults[0].title })
            : t('connectedServicesPool.defaultForMore', { agent: defaults[0].title, count: defaults.length - 1 });
    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            selectedId={null}
            onSelect={(agentId) => {
                const choice = choices.find((candidate) => candidate.agentId === agentId);
                if (choice) onChange(choice.agentId, !choice.isDefault);
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

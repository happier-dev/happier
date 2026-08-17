import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { t } from '@/text';

import type { SshConfiguredHostSuggestion } from './filterConfiguredSshHostSuggestions';
import { Icon } from '@/components/ui/icons/Icon';

export type ApplySshConfiguredHostSuggestion = (suggestion: SshConfiguredHostSuggestion) => void;

export type SshConfiguredHostPickerProps = Readonly<{
    testID: string;
    suggestions: readonly SshConfiguredHostSuggestion[];
    loading: boolean;
    refreshing: boolean;
    unsupported: boolean;
    error: Error | null;
    onRefresh: () => void | Promise<void>;
    onSelectSuggestion: ApplySshConfiguredHostSuggestion;
}>;

function describeSuggestion(suggestion: SshConfiguredHostSuggestion): string {
    const source = suggestion.source === 'ssh-config'
        ? t('settings.sshConfiguredHostPickerSourceSshConfig')
        : t('settings.sshConfiguredHostPickerSourceKnownHosts');
    const username = suggestion.username ? `${suggestion.username}@` : '';
    const port = suggestion.port ? `:${suggestion.port}` : '';
    return `${source} · ${username}${suggestion.hostname}${port}`;
}

export const SshConfiguredHostPicker = React.memo(function SshConfiguredHostPicker(
    props: SshConfiguredHostPickerProps,
) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const byId = React.useMemo(() => new Map(props.suggestions.map((suggestion) => [suggestion.id, suggestion])), [props.suggestions]);
    const items = React.useMemo<DropdownMenuItem[]>(() => props.suggestions.map((suggestion) => ({
        id: suggestion.id,
        title: suggestion.alias,
        subtitle: describeSuggestion(suggestion),
        icon: <Icon name="terminal" size={16} color={theme.colors.text.secondary} />,
    })), [props.suggestions, theme.colors.text.secondary]);

    const handleSelect = React.useCallback((suggestionId: string) => {
        const suggestion = byId.get(suggestionId);
        if (!suggestion) return;
        setOpen(false);
        props.onSelectSuggestion(suggestion);
    }, [byId, props]);

    if (props.unsupported) {
        return (
            <Item
                testID={`${props.testID}-unsupported`}
                title={t('settings.sshConfiguredHostPickerUnsupportedTitle')}
                subtitle={t('settings.sshConfiguredHostPickerUnsupportedSubtitle')}
                mode="info"
                showChevron={false}
            />
        );
    }

    return (
        <View testID={props.testID}>
            {items.length > 0 ? (
                <DropdownMenu
                    testID={`${props.testID}-menu`}
                    open={open}
                    onOpenChange={setOpen}
                    items={items}
                    onSelect={handleSelect}
                    placement="bottom"
                    matchTriggerWidth={true}
                    variant="slim"
                    trigger={({ toggle }) => (
                        <SelectableRow
                            testID={`${props.testID}-trigger`}
                            variant="selectable"
                            selected={open}
                            onPress={toggle}
                            left={<Icon name="terminal" size={16} color={theme.colors.text.secondary} />}
                            title={t('settings.sshConfiguredHostPickerTitle')}
                            subtitle={props.refreshing
                                ? t('settings.sshConfiguredHostPickerRefreshingSubtitle')
                                : t('settings.sshConfiguredHostPickerSubtitle')}
                            right={<Icon name="caret-down" size={16} color={theme.colors.text.secondary} />}
                        />
                    )}
                />
            ) : (
                <Item
                    testID={`${props.testID}-empty`}
                    title={props.loading
                        ? t('settings.sshConfiguredHostPickerLoadingTitle')
                        : t('settings.sshConfiguredHostPickerEmptyTitle')}
                    subtitle={props.loading
                        ? t('settings.sshConfiguredHostPickerLoadingSubtitle')
                        : t('settings.sshConfiguredHostPickerEmptySubtitle')}
                    mode="info"
                    showChevron={false}
                />
            )}

            {props.error ? (
                <Item
                    testID={`${props.testID}-error`}
                    title={t('settings.sshConfiguredHostPickerErrorTitle')}
                    subtitle={props.error.message}
                    mode="info"
                    showChevron={false}
                />
            ) : null}

            <Item
                testID={`${props.testID}-refresh`}
                title={props.refreshing
                    ? t('settings.sshConfiguredHostPickerRefreshingTitle')
                    : t('settings.sshConfiguredHostPickerRefreshTitle')}
                disabled={props.loading || props.refreshing}
                showChevron={false}
                onPress={() => {
                    void props.onRefresh();
                }}
            />
        </View>
    );
});

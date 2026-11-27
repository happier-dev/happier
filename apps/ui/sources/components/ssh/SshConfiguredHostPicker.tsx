import * as React from 'react';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { StepQuietAction } from '@/components/onboarding/unauthShell/StepFormParts';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { t } from '@/text';

import type { SshConfiguredHostSuggestion } from './filterConfiguredSshHostSuggestions';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

export type ApplySshConfiguredHostSuggestion = (suggestion: SshConfiguredHostSuggestion) => void;

export type SshConfiguredHostPickerProps = Readonly<{
    testID: string;
    presentation?: 'suggestions';
    suggestions: readonly SshConfiguredHostSuggestion[];
    loading: boolean;
    refreshing: boolean;
    unsupported: boolean;
    error: Error | null;
    onRefresh: () => void | Promise<void>;
    onSelectSuggestion: ApplySshConfiguredHostSuggestion;
    /** The inline row's last chip (a step's "New host"), drawn in the same row as the hosts. */
    trailingChip?: React.ReactNode;
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
    const inline = props.presentation === 'suggestions';
    const [open, setOpen] = React.useState(false);
    const byId = React.useMemo(() => new Map(props.suggestions.map((suggestion) => [suggestion.id, suggestion])), [props.suggestions]);
    const items = React.useMemo(() => {
        const aliasCounts = new Map<string, number>();
        for (const { alias } of props.suggestions) {
            aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1);
        }
        return props.suggestions.map((suggestion) => {
            const { alias, port, username } = suggestion;
            const host = alias.includes(':') && !alias.startsWith('[') ? `[${alias}]` : alias;
            const title = (aliasCounts.get(alias) ?? 0) > 1
                ? `${username ? `${username}@` : ''}${host}:${port ?? 22}`
                : alias;
            return {
                id: suggestion.id,
                title,
                subtitle: describeSuggestion(suggestion),
                icon: <Icon name="terminal" size={16} color={theme.colors.text.secondary} />,
            } satisfies DropdownMenuItem;
        });
    }, [props.suggestions, theme.colors.text.secondary]);

    const handleSelect = React.useCallback((suggestionId: string) => {
        const suggestion = byId.get(suggestionId);
        if (!suggestion) return;
        setOpen(false);
        props.onSelectSuggestion(suggestion);
    }, [byId, props]);

    if (inline && (props.unsupported || (!items.length && !props.loading && !props.refreshing && !props.error))) return null;

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
        <View testID={props.testID} style={inline ? styles.inlineRoot : undefined}>
            {inline && items.length > 0 ? (
                // The detected hosts as one centred row of chips, the step's own chip last (lab direction A "Which
                // machine?"); each names where it was found as its hint.
                <View style={styles.suggestions}>
                    {items.map(({ id, title, subtitle }) => <SshHostChip
                        key={id}
                        testID={`${props.testID}-${id}`}
                        iconName="terminal"
                        title={title}
                        hint={subtitle}
                        onPress={() => handleSelect(id)}
                    />)}
                    {props.trailingChip}
                </View>
            ) : items.length > 0 ? (
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
            ) : !props.error ? (
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
            ) : null}

            {props.error ? (
                <Item
                    testID={`${props.testID}-error`}
                    title={t('settings.sshConfiguredHostPickerErrorTitle')}
                    subtitle={props.error.message}
                    mode="info"
                    showChevron={false}
                />
            ) : null}

            {inline ? (
                <StepQuietAction
                    testID={`${props.testID}-refresh`}
                    label={props.refreshing
                        ? t('settings.sshConfiguredHostPickerRefreshingTitle')
                        : t('settings.sshConfiguredHostPickerRefreshTitle')}
                    disabled={props.loading || props.refreshing}
                    onPress={() => { void props.onRefresh(); }}
                />
            ) : (
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
            )}
        </View>
    );
});

/**
 * One chip of the row: the small control as a 28 px capsule with its glyph (lab direction A `.r3-chip`), the same
 * object for a detected host and the step's "New host".
 */
export function SshHostChip(props: Readonly<{ testID: string; iconName: IconName; title: string; hint?: string; onPress: () => void }>) {
    const { theme } = useUnistyles();
    return (
        <RoundButton
            testID={props.testID}
            size="small"
            display="secondary"
            capsuleHeight={HAPPIER_PAGE_METRICS.smallControlHeightPx}
            leading={<Icon name={props.iconName} size={14} color={theme.colors.text.secondary} />}
            title={props.title}
            accessibilityHint={props.hint}
            onPress={props.onPress}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    suggestions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: theme.space.s8 },
    inlineRoot: { width: '100%', alignItems: 'center', gap: theme.space.s16 },
}));

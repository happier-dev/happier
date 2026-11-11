import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { SharedSavedSecretReferenceSelectionV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import { useSavedSecretCatalogName } from '@/components/secrets/useSavedSecretCatalog';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { presentSavedSecretReferencePicker } from '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readSavedSecretCatalogEntry } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { t } from '@/text';

/**
 * A field bound to a saved secret: its label, then the chosen secret's name in the form's bordered field (a real
 * control that opens the one saved-secret picker at the field) and Remove once one is chosen. A service configuration
 * binds identity only; the catalog owns names and picker admission.
 */
export function ConnectedAccountConfigurationSecretField(props: Readonly<{
    fieldId: string;
    testIDPrefix?: string;
    title: string;
    description: string;
    secretRef: string | null;
    selection?: SharedSavedSecretReferenceSelectionV1 | null;
    accountLifetime?: ActiveServerAccountScopeLifetime;
    disabled: boolean;
    invalid: boolean;
    errorId: string;
    registerTarget?: (fieldId: string) => (target: React.ComponentRef<typeof View> | null) => void;
    onChange: (selection: SharedSavedSecretReferenceSelectionV1 | null) => void;
}>) {
    const { theme } = useUnistyles();
    const name = useSavedSecretCatalogName(props.secretRef, props.accountLifetime?.scope ?? null);
    const pickerLifetime = React.useMemo(() => ({ controller: new AbortController() }), []);
    React.useEffect(() => {
        // Renew mounted interest after effect replay; Save and unmount retire an open picker.
        if (pickerLifetime.controller.signal.aborted) pickerLifetime.controller = new AbortController();
        const controller = pickerLifetime.controller;
        return () => controller.abort();
    }, [pickerLifetime, props.disabled, props.accountLifetime]);
    const choose = async (event?: unknown) => {
        const lifetime = props.accountLifetime;
        if (props.disabled || !lifetime) return;
        const entry = props.secretRef ? readSavedSecretCatalogEntry(lifetime.scope, props.secretRef) : null;
        const selection = await presentSavedSecretReferencePicker({
            accountLifetime: lifetime,
            selected: props.selection ?? (entry ? { ref: entry.ref, resourceRevision: entry.revision } : null),
            signal: pickerLifetime.controller.signal,
            isCurrent: lifetime.isCurrent,
            anchor: resolvePressTriggerAnchor(event),
        });
        if (selection) props.onChange(selection);
    };
    const prefix = props.testIDPrefix ?? 'connected-account-configuration';
    const unavailable = props.disabled || !props.accountLifetime;
    const value = props.secretRef ? name.name ?? t('secrets.catalog.unavailableName') : null;
    return (
        <View ref={props.registerTarget?.(props.fieldId)}>
            <Item
                title={props.title}
                subtitle={props.description || undefined}
                subtitleLines={0}
                mode="info"
                showChevron={false}
                rightElementOutsidePressable
                accessoryLayout="adaptive"
                rightElement={(
                    <View style={styles.control}>
                        <HappierPressable
                            testID={`${prefix}:${props.fieldId}:choose`}
                            onPress={(event) => void choose(event)}
                            disabled={unavailable}
                            accessibilityRole="button"
                            accessibilityLabel={props.invalid
                                ? `${props.title}: ${t('connectedServices.account.configurationInvalid')}`
                                : `${props.title}: ${value ?? t('settings.mcpServersValueSecretSelect')}`}
                            hasPopup="dialog"
                            style={styles.trigger}
                        >
                            {renderDropdownItemTriggerRightElement({
                                detail: value,
                                open: false,
                                detailColor: theme.colors.text.secondary,
                                chevronColor: theme.colors.text.secondary,
                                field: resolveFieldBoxColors(theme, props.invalid ? 'invalid' : 'idle'),
                                placeholder: t('settings.mcpServersValueSecretSelect'),
                                leading: <Icon name="key" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
                                fieldSpan: 'column',
                            })}
                        </HappierPressable>
                        {props.secretRef ? (
                            <RoundButton
                                testID={`${prefix}:${props.fieldId}:clear`}
                                title={t('common.remove')}
                                size="small"
                                display="secondary"
                                disabled={props.disabled}
                                onPress={() => props.onChange(null)}
                            />
                        ) : null}
                    </View>
                )}
            />
            {props.invalid ? (
                <Text testID={props.errorId} nativeID={props.errorId}
                    accessibilityRole="alert" accessibilityLiveRegion="polite">
                    {t('connectedServices.account.configurationInvalid')}
                </Text>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // The field fills its column like the text fields beside it, beside its label or stacked under it.
    control: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', gap: theme.space.s8, flexGrow: 1, flexShrink: 1, minWidth: 0 },
    trigger: { flexGrow: 1, flexShrink: 1, minWidth: 0, justifyContent: 'center' },
}));

import * as React from 'react';
import { View } from 'react-native';
import type { SharedSavedSecretReferenceSelectionV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import { useSavedSecretCatalogName } from '@/components/secrets/useSavedSecretCatalog';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { presentSavedSecretReferencePicker } from '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readSavedSecretCatalogEntry } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { t } from '@/text';

/** A service configuration binds identity only; the catalog owns names and picker admission. */
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
    const name = useSavedSecretCatalogName(props.secretRef, props.accountLifetime?.scope ?? null);
    const pickerLifetime = React.useMemo(() => ({ controller: new AbortController() }), []);
    React.useEffect(() => {
        // Renew mounted interest after effect replay; Save and unmount retire an open picker.
        if (pickerLifetime.controller.signal.aborted) pickerLifetime.controller = new AbortController();
        const controller = pickerLifetime.controller;
        return () => controller.abort();
    }, [pickerLifetime, props.disabled, props.accountLifetime]);
    const choose = async () => {
        const lifetime = props.accountLifetime;
        if (props.disabled || !lifetime) return;
        const entry = props.secretRef ? readSavedSecretCatalogEntry(lifetime.scope, props.secretRef) : null;
        const selection = await presentSavedSecretReferencePicker({
            accountLifetime: lifetime,
            selected: props.selection ?? (entry ? { ref: entry.ref, resourceRevision: entry.revision } : null),
            signal: pickerLifetime.controller.signal,
            isCurrent: lifetime.isCurrent,
        });
        if (selection) props.onChange(selection);
    };
    return (
        <View ref={props.registerTarget?.(props.fieldId)}>
            <Item
                testID={`${props.testIDPrefix ?? 'connected-account-configuration'}:${props.fieldId}:choose`}
                title={props.title}
                subtitle={props.description || undefined}
                detail={props.secretRef
                    ? name.name ?? t('secrets.catalog.unavailableName')
                    : t('settings.mcpServersValueSecretSelect')}
                accessibilityLabel={props.invalid
                    ? `${props.title}: ${t('connectedServices.account.configurationInvalid')}`
                    : props.title}
                disabled={props.disabled || !props.accountLifetime}
                onPress={() => void choose()}
                rightElement={props.secretRef ? (
                    <RoundButton
                        testID={`${props.testIDPrefix ?? 'connected-account-configuration'}:${props.fieldId}:clear`}
                        title={t('common.remove')}
                        size="small"
                        display="secondary"
                        disabled={props.disabled}
                        onPress={() => props.onChange(null)}
                    />
                ) : undefined}
                rightElementOutsidePressable
                accessoryLayout="adaptive"
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

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { PluginSettingFieldV2 } from '@happier-dev/protocol';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';

import { ConnectedServiceSetupFlowActions } from '../setup/ConnectedServiceSetupFlowBody';
import { ConnectedAccountFormSection } from './ConnectedAccountFormSection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SetupSteps } from '@/components/ui/setupBlocks/SetupSteps';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { resolveProjectedLocalizedText } from '@/components/plugins/surfaces/resolvePluginDisplayString';

import { useConnectedAccountInvalidFieldFocus } from './useConnectedAccountInvalidFieldFocus';
import { useConnectedAccountDraftNavigationGuard } from './useConnectedAccountDraftNavigationGuard';

const stylesheet = StyleSheet.create((theme) => ({
    guided: { gap: 14 },
    field: { width: '100%' },
    accessories: { flexDirection: 'row', alignItems: 'center' },
    note: { ...Typography.default(), fontSize: 12, lineHeight: 17, color: theme.colors.text.secondary },
    panelActions: {
        paddingTop: 12,
    },
    actions: {
        alignItems: 'flex-end',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
}));

type ManualAuthenticationField =
    & Omit<PluginSettingFieldV2, 'secret'>
    & Readonly<{ secret?: boolean }>;

function compareFields(left: ManualAuthenticationField, right: ManualAuthenticationField): number {
    const leftOrder = left.presentation?.order ?? Number.POSITIVE_INFINITY;
    const rightOrder = right.presentation?.order ?? Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.id.localeCompare(right.id);
}

type ConnectedAccountManualFormProps = Readonly<{
    title: string;
    /** Inside the new-account draft, whose row already names the sign-in method. */
    embedded?: boolean;
    localize?: (value: Parameters<typeof resolveProjectedLocalizedText>[0]) => string;
    fields: readonly ManualAuthenticationField[];
    /** Built-in presentation metadata only; the daemon descriptor still owns credential validation. */
    guided?: Readonly<{
        consoleUrl: string;
        createKeyTitle: string;
        billingNote: string;
        shapeHint?: string;
    }>;
    submitting: boolean;
    navigation?: unknown;
    /** In a setup panel: a compact footer with Cancel (local) beside Continue. */
    onCancel?: () => void;
    onSubmit(input: Readonly<{
        fields: Readonly<Record<string, string>>;
        displayName?: string;
    }>): Promise<boolean | void> | boolean | void;
}>;

function ConnectedAccountManualFormBody(props: ConnectedAccountManualFormProps) {
    const styles = stylesheet;
    const initialDraft = React.useMemo(() => (
        Object.fromEntries(props.fields.map((field) => [field.id, '']))
    ), [props.fields]);
    const [draft, setDraft] = React.useState<Readonly<Record<string, string>>>(() => (
        initialDraft
    ));
    const [invalidFieldIds, setInvalidFieldIds] = React.useState<readonly string[]>([]);
    const [displayName, setDisplayName] = React.useState('');
    const [revealed, setRevealed] = React.useState(false);

    const fields = React.useMemo(
        () => [...props.fields]
            .filter((field) => field.presentation?.hidden !== true)
            .sort(compareFields),
        [props.fields],
    );
    const validators = React.useMemo(() => new Map(fields.map((field) => {
        try {
            return [field.id, compilePluginJsonSchema(field.schema)] as const;
        } catch {
            return [field.id, () => false] as const;
        }
    })), [fields]);
    const submit = React.useCallback(async () => {
        const values = Object.fromEntries(
            props.fields.map((field) => [field.id, draft[field.id] ?? '']),
        );
        const invalid = fields
            .filter((field) => !isValidPluginJsonSchemaValue(validators.get(field.id)!, values[field.id] ?? ''))
            .map((field) => field.id);
        if (invalid.length > 0) {
            setInvalidFieldIds(invalid);
            return false;
        }
        const accepted = await props.onSubmit({ fields: values, ...(props.guided && displayName.trim() ? { displayName: displayName.trim() } : {}) });
        return accepted !== false;
    }, [displayName, draft, fields, props, validators]);
    const discardDraft = React.useCallback(() => {
        setDraft(initialDraft);
        setInvalidFieldIds([]);
        setDisplayName('');
        setRevealed(false);
    }, [initialDraft]);
    const isDirty = displayName.length > 0 || props.fields.some((field) => (
        (draft[field.id] ?? '') !== (initialDraft[field.id] ?? '')
    ));
    useConnectedAccountDraftNavigationGuard({
        navigation: props.navigation,
        isDirty,
        onDiscard: discardDraft,
        onSave: submit,
        tag: 'ConnectedAccountManualForm',
    });
    const registerInvalidFieldTarget = useConnectedAccountInvalidFieldFocus({
        invalidFieldIds,
        announcement: t('common.error'),
    });

    const fieldControl = (field: ManualAuthenticationField) => {
        const title = resolveProjectedLocalizedText(field.title, props.localize);
        const invalid = invalidFieldIds.includes(field.id);
        const error = invalid ? (draft[field.id]
            ? t('connectedServicesSettings.manualFieldInvalid', { field: title })
            : t('common.error')) : null;
        return <FieldTextInput
            testID={`connected-account-manual:${field.id}`}
            ref={registerInvalidFieldTarget(field.id)}
            accessibilityLabel={error ? `${title}: ${error}` : title}
            error={error}
            value={draft[field.id] ?? ''}
            onChangeText={(value) => {
                setDraft((current) => ({ ...current, [field.id]: value }));
                setInvalidFieldIds((current) => current.filter((id) => id !== field.id));
            }}
            editable={!props.submitting}
            secureTextEntry={field.secret === true && !revealed}
            multiline={field.presentation?.control === 'textarea'}
            placeholder={resolveProjectedLocalizedText(field.presentation?.placeholder, props.localize)}
            style={props.guided ? styles.field : undefined}
            trailing={props.guided && field.secret ? <View style={styles.accessories}>
                <IconButton testID={`connected-account-manual:${field.id}.reveal`} iconName={revealed ? 'eye-slash' : 'eye'} variant="plain" size={18}
                    accessibilityLabel={t(revealed ? 'connectedServicesSettings.keyHide' : 'connectedServicesSettings.keyReveal')} disabled={props.submitting} onPress={() => setRevealed((value) => !value)} />
                <IconButton testID={`connected-account-manual:${field.id}.clear`} iconName="x" variant="plain" size={18}
                    accessibilityLabel={t('connectedServicesSettings.keyClear')} disabled={props.submitting || !draft[field.id]} onPress={() => setDraft((value) => ({ ...value, [field.id]: '' }))} />
            </View> : undefined}
        />;
    };
    const guided = props.guided;
    const keyShapeOk = fields.some((field) => field.schema.pattern && isValidPluginJsonSchemaValue(validators.get(field.id)!, draft[field.id] ?? ''));
    return (
        <ConnectedAccountFormSection
            embedded={props.embedded}
            title={props.embedded ? undefined : props.title}
            description={invalidFieldIds.length > 0 ? t('common.error') : undefined}
        >
            {guided ? <View style={styles.guided}>
                <SetupSteps steps={[
                    { key: 'create', title: guided.createKeyTitle, state: 'current', body: <RoundButton size="small" display="secondary"
                        title={t('connectedServicesSettings.keyOpenConsole')} trailing={<Icon name="arrow-square-out" size={13} />}
                        onPress={() => openExternalUrl(guided.consoleUrl)} /> },
                    { key: 'paste', title: t('connectedServicesSettings.keyPaste'), state: 'current', body: <View style={styles.field}>
                        {fields.map((field) => <React.Fragment key={field.id}>{fieldControl(field)}</React.Fragment>)}
                        {keyShapeOk && guided.shapeHint ? <Text style={styles.note}>{guided.shapeHint}</Text> : null}
                    </View> },
                    { key: 'name', title: t('connectedServicesSettings.keyName'), detail: t('connectedServicesSettings.keyNameOptional'), body: <FieldTextInput testID="connected-account-manual:name"
                        value={displayName} onChangeText={setDisplayName} accessibilityLabel={t('connectedServicesSettings.keyName')}
                        editable={!props.submitting} style={styles.field} /> },
                ]} />
                <Text style={styles.note}>{guided.billingNote}</Text>
            </View> : fields.map((field) => {
                const title = resolveProjectedLocalizedText(field.title, props.localize);
                const description = resolveProjectedLocalizedText(field.description, props.localize);
                const multiline = field.presentation?.control === 'textarea';
                return (
                    <Item
                        key={field.id}
                        title={title}
                        subtitle={description || undefined}
                        subtitleLines={0}
                        mode="info"
                        showChevron={false}
                        accessoryLayout={multiline ? 'stacked' : 'adaptive'}
                        rightElement={fieldControl(field)}
                    />
                );
            })}
            {props.onCancel ? (
                <View style={styles.panelActions}>
                    <ConnectedServiceSetupFlowActions
                        onCancel={props.onCancel}
                        primary={{
                            testID: 'connected-account-manual:submit',
                            label: t(guided ? 'connectedServicesSettings.keyAdd' : 'common.continue'),
                            disabled: props.submitting,
                            loading: props.submitting,
                            onPress: () => void submit(),
                        }}
                    />
                </View>
            ) : (
                <View style={styles.actions}>
                    <RoundButton
                        testID="connected-account-manual:submit"
                        title={t(guided ? 'connectedServicesSettings.keyAdd' : 'common.continue')}
                        size={guided ? 'small' : undefined}
                        disabled={props.submitting}
                        loading={props.submitting}
                        onPress={submit}
                    />
                </View>
            )}
        </ConnectedAccountFormSection>
    );
}

/**
 * Manual credential fields can change while the route stays mounted (for
 * example after a daemon descriptor refresh). A semantic descriptor key gives
 * the form a fresh local lifetime, so no secret draft survives into a new mode.
 */
export const ConnectedAccountManualForm = React.memo(function ConnectedAccountManualForm(
    props: ConnectedAccountManualFormProps,
) {
    const draftKey = React.useMemo(() => JSON.stringify(props.fields), [props.fields]);
    return <ConnectedAccountManualFormBody key={draftKey} {...props} />;
});

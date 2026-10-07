import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { DaemonNpmRegistryProfileMutationRequestV1 } from '@happier-dev/protocol/rpc';
import { NpmRegistryOriginV1Schema, NpmRegistryProfileInputV1Schema } from '@happier-dev/protocol/rpc';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';

/** Exactly what the canonical mutation carries, so the form cannot invent a shape. */
export type NpmRegistryProfileInputV1 = Extract<
    DaemonNpmRegistryProfileMutationRequestV1,
    Readonly<{ action: 'add' }>
>['profile'];

export type NpmRegistryProfileEditorSubject = Readonly<{
    displayName: string;
    origin: string;
    scopes: readonly string[];
    useAsDefault: boolean;
    allowPrivateNetwork: boolean;
}>;

function readSubmittedFieldError(
    issues: readonly Readonly<{ path: ReadonlyArray<PropertyKey> }>[],
    field: keyof NpmRegistryProfileInputV1,
): string | undefined {
    return issues.some((issue) => issue.path[0] === field)
        ? t('settingsPlugins.registriesInvalidProfileBody')
        : undefined;
}

/**
 * Everything a private registry profile is, answerable in one place.
 *
 * A registry profile is a single decision with five parts — where packages come
 * from, what it is called, which scopes route to it, whether it also serves
 * unscoped packages, and whether it may reach private addresses. Asking those
 * parts as a chain of modal prompts made each answer unreviewable the moment it
 * was given: the reader could not see the origin while choosing its routing,
 * could not go back, and dismissing any step discarded a profile they had
 * already half-described. Here every part is visible at once, Cancel means
 * cancel, and nothing is sent until the whole profile is valid.
 *
 * The credential is deliberately NOT here. A token is a separate custody
 * boundary with its own secure entry and its own daemon mutation; folding it
 * into this form would put a secret into a draft that is edited, re-rendered
 * and abandoned.
 */
export function NpmRegistryProfileEditorModal(props: Readonly<{
    mode: 'create' | 'edit';
    subject?: NpmRegistryProfileEditorSubject;
    onResolve: (profile: NpmRegistryProfileInputV1 | null) => void;
}> & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const { mode, onClose, onResolve, subject } = props;

    const [origin, setOrigin] = React.useState(subject?.origin ?? '');
    const [displayName, setDisplayName] = React.useState(subject?.displayName ?? '');
    const [scopeInput, setScopeInput] = React.useState((subject?.scopes ?? []).join(', '));
    const [useAsDefault, setUseAsDefault] = React.useState(subject?.useAsDefault ?? false);
    const [allowPrivateNetwork, setAllowPrivateNetwork] = React.useState(subject?.allowPrivateNetwork ?? false);
    // Issues from the last rejected submission, so a field explains itself only
    // after the reader has actually tried to save it.
    const [submittedIssues, setSubmittedIssues] = React.useState<readonly Readonly<{ path: ReadonlyArray<PropertyKey> }>[]>([]);

    const trimmedOrigin = origin.trim();
    const parsedOrigin = React.useMemo(
        () => NpmRegistryOriginV1Schema.safeParse(trimmedOrigin),
        [trimmedOrigin],
    );
    // An empty field is unfinished, not wrong: the origin only reads as invalid
    // once the reader has typed something that cannot be one.
    const originError = trimmedOrigin.length > 0 && !parsedOrigin.success
        ? t('settingsPlugins.registriesInvalidOriginBody')
        : undefined;
    const canSave = parsedOrigin.success && displayName.trim().length > 0;

    const save = React.useCallback(() => {
        if (!parsedOrigin.success) return;
        const parsed = NpmRegistryProfileInputV1Schema.safeParse({
            displayName: displayName.trim(),
            origin: parsedOrigin.data,
            scopes: scopeInput.split(',').map((scope) => scope.trim()).filter(Boolean),
            useAsDefault,
            allowPrivateNetwork,
        });
        if (!parsed.success) {
            setSubmittedIssues(parsed.error.issues);
            return;
        }
        setSubmittedIssues([]);
        onResolve(parsed.data);
        onClose();
    }, [allowPrivateNetwork, displayName, onClose, onResolve, parsedOrigin, scopeInput, useAsDefault]);

    const cancel = React.useCallback(() => {
        onResolve(null);
        onClose();
    }, [onClose, onResolve]);

    const footer = React.useMemo(() => (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
        }}>
            <RoundButton
                size="normal"
                display="inverted"
                title={t('common.cancel')}
                testID="settings.plugins.registries.editor.cancel"
                onPress={cancel}
            />
            <RoundButton
                size="normal"
                title={t('common.save')}
                testID="settings.plugins.registries.editor.save"
                disabled={!canSave}
                onPress={save}
            />
        </View>
    ), [canSave, cancel, save]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: mode === 'create'
            ? t('settingsPlugins.registriesAddTitle')
            : t('settingsPlugins.registriesEdit'),
        testID: 'settings.plugins.registries.editor',
        dimensions: { width: 560, maxHeightRatio: 0.92, size: 'md' as const },
        footer,
    }), [footer, mode]);

    useModalCardChrome(props.setChrome, chrome);

    const cardStyle = {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.base,
        overflow: 'hidden' as const,
    };

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            <ScrollView
                style={{ flex: 1 }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
                {...(Platform.OS === 'ios' ? { automaticallyAdjustKeyboardInsets: true } : {})}
                contentContainerStyle={{
                    paddingHorizontal: 20,
                    paddingTop: 14,
                    paddingBottom: 18,
                    gap: 14,
                }}
            >
                <View style={[cardStyle, { padding: 12, gap: 14 }]}>
                    {/*
                      * The origin is the profile's identity, so an existing
                      * profile shows it rather than hiding or re-asking it: the
                      * reader is changing how a known registry is used, not
                      * repointing it at a different one.
                      */}
                    <MachineSetupTextField
                        testID="settings.plugins.registries.editor.origin"
                        label={t('settingsPlugins.registriesOriginTitle')}
                        supportText={t('settingsPlugins.registriesAddOriginBody')}
                        errorText={originError}
                        editable={mode === 'create'}
                        value={origin}
                        placeholder="https://registry.example.com"
                        autoCapitalize="none"
                        autoCorrect={false}
                        onChangeText={setOrigin}
                    />
                    <MachineSetupTextField
                        testID="settings.plugins.registries.editor.displayName"
                        label={t('settingsPlugins.registriesNameTitle')}
                        supportText={t('settingsPlugins.registriesNameBody')}
                        errorText={readSubmittedFieldError(submittedIssues, 'displayName')}
                        value={displayName}
                        onChangeText={setDisplayName}
                    />
                    <MachineSetupTextField
                        testID="settings.plugins.registries.editor.scopes"
                        label={t('settingsPlugins.registriesScopesTitle')}
                        supportText={t('settingsPlugins.registriesScopesBody')}
                        errorText={readSubmittedFieldError(submittedIssues, 'scopes')}
                        value={scopeInput}
                        placeholder={t('settingsPlugins.registriesScopesPlaceholder')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        onChangeText={setScopeInput}
                    />
                </View>

                <View style={cardStyle}>
                    <Item
                        testID="settings.plugins.registries.editor.useAsDefault"
                        title={t('settingsPlugins.registriesDefaultTitle')}
                        subtitle={useAsDefault
                            ? t('settingsPlugins.registriesUseAsDefault')
                            : t('settingsPlugins.registriesScopedOnly')}
                        subtitleLines={0}
                        rightElement={<Switch value={useAsDefault} onValueChange={setUseAsDefault} />}
                        rightElementOutsidePressable
                        onPress={() => setUseAsDefault((current) => !current)}
                        showChevron={false}
                    />
                    <Item
                        testID="settings.plugins.registries.editor.allowPrivateNetwork"
                        title={t('settingsPlugins.registriesPrivateNetworkTitle')}
                        subtitle={allowPrivateNetwork
                            ? t('settingsPlugins.registriesAllowPrivateNetwork')
                            : t('settingsPlugins.registriesPublicOnly')}
                        subtitleLines={0}
                        rightElement={<Switch value={allowPrivateNetwork} onValueChange={setAllowPrivateNetwork} />}
                        rightElementOutsidePressable
                        onPress={() => setAllowPrivateNetwork((current) => !current)}
                        showChevron={false}
                        showDivider={false}
                    />
                </View>
            </ScrollView>
        </View>
    );
}

/**
 * Opens the profile form and resolves the profile the reader actually finished.
 *
 * `null` is an abandoned form — dismissal, Cancel, or the host being torn down —
 * and never a partially answered profile.
 */
export async function showNpmRegistryProfileEditor(params: Readonly<{
    mode: 'create' | 'edit';
    subject?: NpmRegistryProfileEditorSubject;
}>): Promise<NpmRegistryProfileInputV1 | null> {
    return await new Promise((resolve) => {
        let settled = false;
        const settle = (profile: NpmRegistryProfileInputV1 | null) => {
            if (settled) return;
            settled = true;
            resolve(profile);
        };
        Modal.show({
            component: NpmRegistryProfileEditorModal,
            props: {
                mode: params.mode,
                ...(params.subject ? { subject: params.subject } : {}),
                onResolve: settle,
            },
            onRequestClose: () => settle(null),
            onHostUnmount: () => settle(null),
            closeOnBackdrop: true,
        });
    });
}

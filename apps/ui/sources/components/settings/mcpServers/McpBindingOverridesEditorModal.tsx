import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    McpServerBindingOverridesV1,
    McpServerBindingV1,
    McpServerCatalogEntryTransportV1,
    McpValueRefV1,
} from '@happier-dev/protocol';

import type { CustomModalInjectedProps } from '@/modal';
import { Modal } from '@/modal';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { Switch } from '@/components/ui/forms/Switch';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { t } from '@/text';

import { ValueRefEditorModal, getValueRefEditorModalTitle } from '@/components/ui/forms/valueRefs/ValueRefEditorModal';
import { McpBindingOverridesValuePatchGroup } from '@/components/settings/mcpServers/bindingOverrides/McpBindingOverridesValuePatchGroup';

const ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_KEY_REGEX = /^[A-Za-z0-9-]+$/;

const stylesheet = StyleSheet.create((theme) => ({
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.secondary,
        marginBottom: 8,
        marginTop: 8,
    },
    textInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        ...SETTINGS_TEXT_INPUT_METRICS,
        color: theme.colors.input.text,
        borderWidth: 0.5,
        borderColor: theme.colors.border.default,
    },
    padded: {
        paddingHorizontal: 16,
        paddingBottom: 16,
    },
}));

function pruneEmptyOverrides(overrides: McpServerBindingOverridesV1): McpServerBindingOverridesV1 | undefined {
    const hasStdio = overrides.stdio && (overrides.stdio.command !== undefined || overrides.stdio.args !== undefined);
    const hasRemote = overrides.remote && (overrides.remote.url !== undefined || overrides.remote.headersPatch !== undefined);
    const hasEnv = overrides.envPatch && Object.keys(overrides.envPatch).length > 0;

    const next: McpServerBindingOverridesV1 = {};
    if (hasStdio) next.stdio = overrides.stdio;
    if (hasRemote) next.remote = overrides.remote;
    if (hasEnv) next.envPatch = overrides.envPatch;
    if (!next.stdio && !next.remote && !next.envPatch) return undefined;
    return next;
}

function parseArgsText(text: string): string[] {
    if (!text.trim()) return [];
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

export type McpBindingOverridesEditorModalProps = CustomModalInjectedProps & Readonly<{
    binding: McpServerBindingV1;
    serverTransport: McpServerCatalogEntryTransportV1;
    secrets: SavedSecret[];
    onChangeSecrets: (next: SavedSecret[]) => void;
    onSubmit: (next: McpServerBindingV1) => void;
}>;

export function getBindingOverridesValueRefEditorChrome(kind: 'env' | 'header') {
    return {
        kind: 'card',
        title: getValueRefEditorModalTitle(kind),
        dimensions: { size: 'lg' },
    } as const;
}

export function McpBindingOverridesEditorModal(props: McpBindingOverridesEditorModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const initialOverrides = props.binding.overrides ?? {};

    const [commandOverrideEnabled, setCommandOverrideEnabled] = React.useState(() => initialOverrides.stdio?.command !== undefined);
    const [commandOverride, setCommandOverride] = React.useState(() => initialOverrides.stdio?.command ?? '');

    const [argsOverrideEnabled, setArgsOverrideEnabled] = React.useState(() => initialOverrides.stdio?.args !== undefined);
    const [argsOverrideText, setArgsOverrideText] = React.useState(() => (initialOverrides.stdio?.args ?? []).join('\n'));

    const [urlOverrideEnabled, setUrlOverrideEnabled] = React.useState(() => initialOverrides.remote?.url !== undefined);
    const [urlOverride, setUrlOverride] = React.useState(() => initialOverrides.remote?.url ?? '');

    const [envPatch, setEnvPatch] = React.useState<Record<string, McpValueRefV1 | null>>(() => initialOverrides.envPatch ?? {});
    const [headersPatch, setHeadersPatch] = React.useState<Record<string, McpValueRefV1 | null>>(() => initialOverrides.remote?.headersPatch ?? {});

    const openValueRefModal = React.useCallback((params: Readonly<{
        kind: 'env' | 'header';
        initialKey: string;
        initialValueRef: McpValueRefV1;
        existingKeys: ReadonlySet<string>;
        onDelete: () => void;
        onSubmit: (next: { key: string; valueRef: McpValueRefV1 }) => void;
    }>) => {
        Modal.show({
            component: ValueRefEditorModal,
            props: {
                kind: params.kind,
                initialKey: params.initialKey,
                initialValueRef: params.initialValueRef,
                secrets: props.secrets,
                onChangeSecrets: props.onChangeSecrets,
                onDelete: params.onDelete,
                onSubmit: ({ key, valueRef }) => {
                    if (params.initialKey !== key && params.existingKeys.has(key)) {
                        Modal.alert(t('common.error'), t('settings.mcpServersKeyAlreadyExists'));
                        return false;
                    }
                    params.onSubmit({ key, valueRef });
                    return true;
                },
            },
            chrome: getBindingOverridesValueRefEditorChrome(params.kind),
            closeOnBackdrop: true,
        });
    }, [props.onChangeSecrets, props.secrets]);

    const addDeletePatchKey = React.useCallback(async (kind: 'env' | 'header') => {
        const title = kind === 'env' ? t('settings.mcpServersOverridesDeleteEnvTitle') : t('settings.mcpServersOverridesDeleteHeaderTitle');
        const prompt = kind === 'env' ? t('settings.mcpServersOverridesDeleteEnvPrompt') : t('settings.mcpServersOverridesDeleteHeaderPrompt');
        const raw = await Modal.prompt(title, prompt, {
            placeholder: kind === 'env' ? t('settings.mcpServersEnvKeyPlaceholder') : t('settings.mcpServersHeaderKeyPlaceholder'),
        });
        if (typeof raw !== 'string') return;
        const key = kind === 'env' ? raw.trim().toUpperCase() : raw.trim();
        const valid = kind === 'env' ? ENV_KEY_REGEX.test(key) : HEADER_KEY_REGEX.test(key);
        if (!valid) {
            Modal.alert(t('common.error'), t('settings.mcpServersKeyInvalid'));
            return;
        }
        if (kind === 'env') {
            setEnvPatch((prev) => ({ ...prev, [key]: null }));
        } else {
            setHeadersPatch((prev) => ({ ...prev, [key]: null }));
        }
    }, []);

    const onSave = React.useCallback(() => {
        const stdioOverride = (() => {
            if (props.serverTransport !== 'stdio') return undefined;
            const next: { command?: string; args?: string[] } = {};
            if (commandOverrideEnabled) {
                const value = commandOverride.trim();
                if (!value) {
                    Modal.alert(t('common.error'), t('settings.mcpServersOverridesCommandRequired'));
                    return null;
                }
                next.command = value;
            }
            if (argsOverrideEnabled) {
                next.args = parseArgsText(argsOverrideText);
            }
            if (next.command === undefined && next.args === undefined) return undefined;
            return next;
        })();
        if (stdioOverride === null) return;

        const remoteOverride = (() => {
            if (props.serverTransport === 'stdio') return undefined;
            const next: { url?: string; headersPatch?: Record<string, McpValueRefV1 | null> } = {};
            if (urlOverrideEnabled) {
                const value = urlOverride.trim();
                if (!value) {
                    Modal.alert(t('common.error'), t('settings.mcpServersOverridesUrlRequired'));
                    return null;
                }
                next.url = value;
            }
            if (Object.keys(headersPatch).length > 0) {
                next.headersPatch = headersPatch;
            }
            if (next.url === undefined && next.headersPatch === undefined) return undefined;
            return next;
        })();
        if (remoteOverride === null) return;

        const overrides: McpServerBindingOverridesV1 = {
            ...(stdioOverride ? { stdio: stdioOverride } : {}),
            ...(remoteOverride ? { remote: remoteOverride } : {}),
            ...(Object.keys(envPatch).length > 0 ? { envPatch } : {}),
        };

        const pruned = pruneEmptyOverrides(overrides);
        props.onSubmit({ ...props.binding, overrides: pruned, updatedAt: Date.now() });
        props.onClose();
    }, [
        argsOverrideEnabled,
        argsOverrideText,
        commandOverride,
        commandOverrideEnabled,
        envPatch,
        headersPatch,
        props,
        urlOverride,
        urlOverrideEnabled,
    ]);

    return (
        <ItemList style={{ paddingTop: 0 }} keyboardShouldPersistTaps="handled">
            {props.serverTransport === 'stdio' ? (
                <ItemGroup title={t('settings.mcpServersOverridesStdioTitle')}>
                    <Item
                        title={t('settings.mcpServersOverridesCommandTitle')}
                        subtitle={t('settings.mcpServersOverridesCommandSubtitle')}
                        icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.accent.purple} />}
                        rightElement={<Switch value={commandOverrideEnabled} onValueChange={setCommandOverrideEnabled} />}
                        onPress={() => setCommandOverrideEnabled((v) => !v)}
                        showChevron={false}
                    />
                    {commandOverrideEnabled ? (
                        <View style={styles.padded}>
                            <Text style={styles.fieldLabel}>{t('settings.mcpServersFieldCommand')}</Text>
                            <TextInput
                                style={styles.textInput}
                                value={commandOverride}
                                onChangeText={setCommandOverride}
                                autoCapitalize="none"
                                autoCorrect={false}
                                placeholder="node"
                                placeholderTextColor={theme.colors.input.placeholder}
                            />
                        </View>
                    ) : null}

                    <Item
                        title={t('settings.mcpServersOverridesArgsTitle')}
                        subtitle={t('settings.mcpServersOverridesArgsSubtitle')}
                        icon={<Ionicons name="list-outline" size={29} color={theme.colors.accent.blue} />}
                        rightElement={<Switch value={argsOverrideEnabled} onValueChange={setArgsOverrideEnabled} />}
                        onPress={() => setArgsOverrideEnabled((v) => !v)}
                        showChevron={false}
                    />
                    {argsOverrideEnabled ? (
                        <View style={styles.padded}>
                            <Text style={styles.fieldLabel}>{t('settings.mcpServersFieldArgs')}</Text>
                            <TextInput
                                style={styles.textInput}
                                value={argsOverrideText}
                                onChangeText={setArgsOverrideText}
                                autoCapitalize="none"
                                autoCorrect={false}
                                multiline
                                placeholder={t('settings.mcpServersArgsPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                            />
                        </View>
                    ) : null}
                </ItemGroup>
            ) : (
                <ItemGroup title={t('settings.mcpServersOverridesRemoteTitle')}>
                    <Item
                        title={t('settings.mcpServersOverridesUrlTitle')}
                        subtitle={t('settings.mcpServersOverridesUrlSubtitle')}
                        icon={<Ionicons name="link-outline" size={29} color={theme.colors.accent.purple} />}
                        rightElement={<Switch value={urlOverrideEnabled} onValueChange={setUrlOverrideEnabled} />}
                        onPress={() => setUrlOverrideEnabled((v) => !v)}
                        showChevron={false}
                    />
                    {urlOverrideEnabled ? (
                        <View style={styles.padded}>
                            <Text style={styles.fieldLabel}>{t('settings.mcpServersFieldUrl')}</Text>
                            <TextInput
                                style={styles.textInput}
                                value={urlOverride}
                                onChangeText={setUrlOverride}
                                autoCapitalize="none"
                                autoCorrect={false}
                                placeholder="https://example.com/mcp"
                                placeholderTextColor={theme.colors.input.placeholder}
                            />
                        </View>
                    ) : null}
                </ItemGroup>
            )}

            <McpBindingOverridesValuePatchGroup
                kind="env"
                patch={envPatch}
                setPatch={setEnvPatch}
                openValueRefModal={openValueRefModal}
                onPressDeleteKey={() => { void addDeletePatchKey('env'); }}
            />

            {props.serverTransport === 'stdio' ? null : (
                <McpBindingOverridesValuePatchGroup
                    kind="header"
                    patch={headersPatch}
                    setPatch={setHeadersPatch}
                    openValueRefModal={openValueRefModal}
                    onPressDeleteKey={() => { void addDeletePatchKey('header'); }}
                />
            )}

            <ItemGroup title={t('common.actions')}>
                <Item
                    testID="mcp.bindingOverrides.save"
                    title={t('common.save')}
                    icon={<Ionicons name="save-outline" size={29} color={theme.colors.state.success.foreground} />}
                    onPress={onSave}
                />
            </ItemGroup>
        </ItemList>
    );
}

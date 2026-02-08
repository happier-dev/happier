import React from 'react';
import { Platform, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { sync } from '@/sync/sync';
import { useSettings } from '@/sync/storage';
import { isAgentId, type AgentId } from '@/agents/catalog';
import { getProviderSettingsPlugin } from '@/agents/providers/_registry/providerSettingsRegistry';
import { t } from '@/text';

const ProviderSettingsNumberField = React.memo(function ProviderSettingsNumberField(props: {
    field: any;
    value: unknown;
    theme: any;
    localInputs: Record<string, string>;
    setLocalInputs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    setSetting: (key: string, value: unknown) => void;
}) {
    const { field, value, theme, localInputs, setLocalInputs, setSetting } = props;

    const rawFromSetting = typeof value === 'number' ? String(value) : '';
    const externalRaw = value === null || value === undefined ? '' : rawFromSetting;
    const raw = Object.prototype.hasOwnProperty.call(localInputs, field.key)
        ? localInputs[field.key]!
        : externalRaw;
    const parsed = raw.trim().length === 0 ? null : Number(raw);

    const isStepAligned = (n: number, step: number, base: number) => {
        if (!Number.isFinite(n) || !Number.isFinite(step) || step <= 0) return true;
        const scaled = (n - base) / step;
        const rounded = Math.round(scaled);
        return Math.abs(scaled - rounded) < 1e-9;
    };

    const spec = field.numberSpec;
    const isValid =
        parsed === null
            ? true
            : Number.isFinite(parsed)
              && (spec?.min == null || parsed >= spec.min)
              && (spec?.max == null || parsed <= spec.max)
              && (spec?.step == null || isStepAligned(parsed, spec.step, spec?.min ?? 0));
    const showError = raw.trim().length > 0 && !isValid;

    const clearLocalInput = React.useCallback(() => {
        setLocalInputs((prev) => {
            if (!(field.key in prev)) return prev;
            const next = { ...prev };
            delete next[field.key];
            return next;
        });
    }, [field.key, setLocalInputs]);

    const [focused, setFocused] = React.useState(false);
    const prevExternalRawRef = React.useRef(externalRaw);
    React.useEffect(() => {
        const prevExternalRaw = prevExternalRawRef.current;
        prevExternalRawRef.current = externalRaw;
        if (focused) return;
        if (prevExternalRaw === externalRaw) return;
        clearLocalInput();
    }, [clearLocalInput, externalRaw, focused]);

    return (
        <View style={[styles.inputContainer, { paddingTop: 0 }]}>
            <Text style={styles.fieldLabel}>{field.title}</Text>
            {field.subtitle && (
                <Text style={{ ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary, marginBottom: 6 }}>
                    {field.subtitle}
                </Text>
            )}
            <TextInput
                style={[
                    styles.textInput,
                    showError ? { borderWidth: 1, borderColor: theme.colors.textDestructive } : null,
                ]}
                placeholder={field.numberSpec?.placeholder ?? t('common.optional')}
                placeholderTextColor={theme.colors.input.placeholder}
                value={raw}
                keyboardType={Platform.select({ ios: 'number-pad', default: 'numeric' })}
                onFocus={() => setFocused(true)}
                onChangeText={(next) => {
                    setLocalInputs((prev) => ({ ...prev, [field.key]: next }));
                    const trimmed = next.trim();
                    if (!trimmed) {
                        setSetting(field.key, null);
                        return;
                    }
                    const n = Number(trimmed);
                    if (!Number.isFinite(n)) {
                        return;
                    }
                    if (field.numberSpec?.min != null && n < field.numberSpec.min) {
                        return;
                    }
                    if (field.numberSpec?.max != null && n > field.numberSpec.max) {
                        return;
                    }
                    if (field.numberSpec?.step != null && !isStepAligned(n, field.numberSpec.step, field.numberSpec?.min ?? 0)) {
                        return;
                    }
                    setSetting(field.key, n);
                }}
                onBlur={() => {
                    setFocused(false);
                    const trimmed = raw.trim();
                    if (!trimmed) {
                        clearLocalInput();
                        return;
                    }
                    if (isValid) {
                        clearLocalInput();
                    }
                }}
                autoCapitalize="none"
                autoCorrect={false}
            />
            {showError && (
                <Text style={{ ...Typography.default(), fontSize: 12, color: theme.colors.textDestructive, marginTop: 6 }}>
                    {t('settingsProviders.invalidNumber')}
                </Text>
            )}
        </View>
    );
});

export default React.memo(function ProviderSettingsScreen() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams();
    const rawProviderId = params.providerId;
    const providerId = typeof rawProviderId === 'string' && isAgentId(rawProviderId) ? (rawProviderId as AgentId) : null;
    const plugin = providerId ? getProviderSettingsPlugin(providerId) : null;
    const settings = useSettings();

    const popoverBoundaryRef = React.useRef<any>(null);
    const [openMenu, setOpenMenu] = React.useState<null | string>(null);
    const [localInputs, setLocalInputs] = React.useState<Record<string, string>>({});

    const setSetting = React.useCallback((key: string, value: unknown) => {
        sync.applySettings({ [key]: value } as any);
    }, []);

    if (!providerId || !plugin) {
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup>
                    <View style={{ alignItems: 'center', paddingVertical: 32, paddingHorizontal: 16 }}>
                        <Ionicons name="warning-outline" size={48} color={theme.colors.textDestructive} style={{ marginBottom: 16 }} />
                        <Text style={{ ...Typography.default('semiBold'), fontSize: 16, color: theme.colors.textDestructive, textAlign: 'center', marginBottom: 8 }}>
                            {t('settingsProviders.notFoundTitle')}
                        </Text>
                        <Text style={{ ...Typography.default(), fontSize: 14, color: theme.colors.textSecondary, textAlign: 'center', lineHeight: 20 }}>
                            {t('settingsProviders.notFoundSubtitle')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <View ref={popoverBoundaryRef} style={{ flex: 1 }}>
            <ItemList style={{ paddingTop: 0 }}>
                {plugin.uiSections.map((section) => (
                    <ItemGroup key={section.id} title={section.title} footer={section.footer}>
                        {section.fields.map((field) => {
                            const value = (settings as any)[field.key];

                            if (field.kind === 'boolean') {
                                const boolValue = Boolean(value);
                                return (
                                    <Item
                                        key={field.key}
                                        title={field.title}
                                        subtitle={field.subtitle}
                                        icon={<Ionicons name="options-outline" size={29} color={theme.colors.textSecondary} />}
                                        rightElement={<Switch value={boolValue} onValueChange={(v) => setSetting(field.key, v)} />}
                                        showChevron={false}
                                        onPress={() => setSetting(field.key, !boolValue)}
                                    />
                                );
                            }

                            if (field.kind === 'enum') {
                                const options = field.enumOptions ?? [];
                                if (options.length === 0) {
                                    return (
                                        <Item
                                            key={field.key}
                                            title={field.title}
                                            subtitle={field.subtitle ?? t('settingsProviders.noOptionsAvailable')}
                                            icon={<Ionicons name="list-outline" size={29} color={theme.colors.textSecondary} />}
                                            showChevron={false}
                                            disabled={true}
                                        />
                                    );
                                }
                                const currentId = typeof value === 'string' ? value : (options[0]?.id ?? '');
                                const subtitle = options.find((o) => o.id === currentId)?.title ?? String(currentId);

                                return (
                                    <DropdownMenu
                                        key={field.key}
                                        open={openMenu === field.key}
                                        onOpenChange={(next) => setOpenMenu(next ? field.key : null)}
                                        variant="selectable"
                                        search={false}
                                        selectedId={currentId}
                                        showCategoryTitles={false}
                                        matchTriggerWidth={true}
                                        connectToTrigger={true}
                                        rowKind="item"
                                        popoverBoundaryRef={popoverBoundaryRef}
                                        trigger={({ open, toggle }) => (
                                            <Item
                                                title={field.title}
                                                subtitle={field.subtitle ?? subtitle}
                                                icon={<Ionicons name="list-outline" size={29} color={theme.colors.textSecondary} />}
                                                rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                                                onPress={toggle}
                                                showChevron={false}
                                                selected={false}
                                            />
                                        )}
                                        items={options.map((opt) => ({
                                            id: opt.id,
                                            title: opt.title,
                                            subtitle: opt.subtitle,
                                            icon: (
                                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                    <Ionicons name="radio-button-on-outline" size={22} color={theme.colors.textSecondary} />
                                                </View>
                                            ),
                                        }))}
                                        onSelect={(id) => {
                                            setSetting(field.key, id);
                                            setOpenMenu(null);
                                        }}
                                    />
                                );
                            }

                            if (field.kind === 'number') {
                                return (
                                    <ProviderSettingsNumberField
                                        key={field.key}
                                        field={field}
                                        value={value}
                                        theme={theme}
                                        localInputs={localInputs}
                                        setLocalInputs={setLocalInputs}
                                        setSetting={setSetting}
                                    />
                                );
                            }

                            if (field.kind === 'json' || field.kind === 'text') {
                                const textValue = typeof value === 'string' ? value : '';
                                const localValue = localInputs[field.key] ?? textValue;
                                const jsonError =
                                    field.kind === 'json' && localValue.trim().length > 0
                                        ? (() => {
                                            try {
                                                JSON.parse(localValue);
                                                return null;
                                            } catch {
                                                return t('settingsProviders.invalidJson');
                                            }
                                        })()
                                        : null;

                                const commitJsonIfValid = () => {
                                    if (field.kind !== 'json') return;
                                    if (jsonError) return;
                                    setSetting(field.key, localValue);
                                    setLocalInputs((prev) => {
                                        if (!(field.key in prev)) return prev;
                                        const next = { ...prev };
                                        delete next[field.key];
                                        return next;
                                    });
                                };

                                return (
                                    <View key={field.key} style={[styles.inputContainer, { paddingTop: 0 }]}>
                                        <Text style={styles.fieldLabel}>{field.title}</Text>
                                        {field.subtitle && (
                                            <Text style={{ ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary, marginBottom: 6 }}>
                                                {field.subtitle}
                                            </Text>
                                        )}
                                        <TextInput
                                            style={[
                                                styles.textInput,
                                                {
                                                    minHeight: field.kind === 'json' ? 110 : 44,
                                                    textAlignVertical: field.kind === 'json' ? 'top' : 'center',
                                                } as any,
                                                jsonError ? { borderWidth: 1, borderColor: theme.colors.textDestructive } : null,
                                            ]}
                                            multiline={field.kind === 'json'}
                                            placeholder={field.kind === 'json' ? '{ }' : ''}
                                            placeholderTextColor={theme.colors.input.placeholder}
                                            value={field.kind === 'json' ? localValue : textValue}
                                            onChangeText={(next) => {
                                                if (field.kind === 'json') {
                                                    setLocalInputs((prev) => ({ ...prev, [field.key]: next }));
                                                    return;
                                                }
                                                setSetting(field.key, next);
                                            }}
                                            onEndEditing={commitJsonIfValid}
                                            onBlur={commitJsonIfValid}
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                        />
                                        {jsonError && (
                                            <Text style={{ ...Typography.default(), fontSize: 12, color: theme.colors.textDestructive, marginTop: 6 }}>
                                                {jsonError}
                                            </Text>
                                        )}
                                    </View>
                                );
                            }

                            return null;
                        })}
                    </ItemGroup>
                ))}
            </ItemList>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    inputContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        marginBottom: 4,
    },
    textInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.input.text,
        ...(Platform.select({
            web: {
                outline: 'none',
                outlineStyle: 'none',
                outlineWidth: 0,
                outlineColor: 'transparent',
                boxShadow: 'none',
                WebkitBoxShadow: 'none',
                WebkitAppearance: 'none',
            },
            default: {},
        }) as object),
    },
}));

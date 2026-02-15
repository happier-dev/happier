import * as React from 'react';
import { View, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/StyledText';
import { t } from '@/text';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { Typography } from '@/constants/Typography';

type AddTargetsSectionProps = Readonly<{
    // Add server form
    autoMode: boolean;
    inputUrl: string;
    inputName: string;
    error: string | null;
    isValidating: boolean;
    onChangeUrl: (value: string) => void;
    onChangeName: (value: string) => void;
    onResetServer: () => Promise<void> | void;
    onAddServer: () => Promise<void> | void;

    // Add server group form
    servers: ReadonlyArray<ServerProfile>;
    activeServerId: string;
    onCreateServerGroup: (params: { name: string; serverIds: string[] }) => Promise<boolean> | boolean;
}>;

type ExpandedKind = 'server' | 'group' | null;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

const stylesheet = StyleSheet.create((theme) => ({
    contentContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    labelText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 8,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
        ...Typography.mono(),
        fontSize: 14,
        color: theme.colors.input.text,
    },
    textInputValidating: {
        opacity: 0.6,
    },
    errorText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textDestructive,
        marginBottom: 12,
    },
    validatingText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.status.connecting,
        marginBottom: 12,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 12,
        marginBottom: 12,
    },
    buttonWrapper: {
        flex: 1,
    },
    statusText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));

export function AddTargetsSection(props: AddTargetsSectionProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [expanded, setExpanded] = React.useState<ExpandedKind>(null);

    const [groupName, setGroupName] = React.useState('');
    const [groupServerIds, setGroupServerIds] = React.useState<string[]>([]);
    const [isSavingGroup, setIsSavingGroup] = React.useState(false);

    const toggleExpanded = React.useCallback((kind: ExpandedKind) => {
        setExpanded((prev) => {
            const next = prev === kind ? null : kind;
            return next;
        });
    }, []);

    React.useEffect(() => {
        if (expanded !== 'group') return;
        // Seed selection from current active server for a predictable first group.
        const seed = normalizeId(props.activeServerId);
        setGroupServerIds((prev) => {
            if (prev.length > 0) return prev;
            return seed ? [seed] : [];
        });
    }, [expanded, props.activeServerId]);

    const selectedGroupServerIds = React.useMemo(() => {
        const seen = new Set<string>();
        const next: string[] = [];
        for (const raw of groupServerIds) {
            const id = normalizeId(raw);
            if (!id) continue;
            if (seen.has(id)) continue;
            seen.add(id);
            next.push(id);
        }
        return next;
    }, [groupServerIds]);

    const handleToggleGroupServer = React.useCallback((serverId: string) => {
        const id = normalizeId(serverId);
        if (!id) return;
        setGroupServerIds((prev) => {
            const next = new Set(prev.map(normalizeId).filter(Boolean));
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return Array.from(next);
        });
    }, []);

    const handleSaveGroup = React.useCallback(async () => {
        if (isSavingGroup) return;
        const trimmedName = groupName.trim();
        if (!trimmedName) return;
        if (selectedGroupServerIds.length === 0) return;
        setIsSavingGroup(true);
        try {
            const ok = await props.onCreateServerGroup({
                name: trimmedName,
                serverIds: selectedGroupServerIds,
            });
            if (!ok) return;
            setGroupName('');
            setGroupServerIds([]);
            setExpanded(null);
        } finally {
            setIsSavingGroup(false);
        }
    }, [groupName, isSavingGroup, props, selectedGroupServerIds]);

    return (
        <ItemGroup title={t('server.addTargetsTitle')}>
            <Item
                title={t('server.addServerTitle')}
                subtitle={t('server.addServerSubtitle')}
                icon={<Ionicons name="server-outline" size={20} color={theme.colors.textSecondary} />}
                rightElement={(
                    <Ionicons
                        name={expanded === 'server' ? 'chevron-up' : 'chevron-down'}
                        size={18}
                        color={theme.colors.textSecondary}
                    />
                )}
                showChevron={false}
                onPress={() => toggleExpanded('server')}
            />
            {expanded === 'server' ? (
                <View style={styles.contentContainer}>
                    {props.autoMode ? (
                        <Text style={[styles.statusText, { marginBottom: 12 }]}>
                            {t('server.autoConfigHint')}
                        </Text>
                    ) : null}

                    <Text style={styles.labelText}>{t('server.customServerUrlLabel').toUpperCase()}</Text>
                    <TextInput
                        style={[
                            styles.textInput,
                            props.isValidating && styles.textInputValidating,
                        ]}
                        value={props.inputUrl}
                        onChangeText={props.onChangeUrl}
                        placeholder={t('common.urlPlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        editable={!props.isValidating}
                    />

                    {props.autoMode ? null : (
                        <>
                            <Text style={styles.labelText}>{t('server.serverNameLabel').toUpperCase()}</Text>
                            <TextInput
                                style={[
                                    styles.textInput,
                                    props.isValidating && styles.textInputValidating,
                                ]}
                                value={props.inputName}
                                onChangeText={props.onChangeName}
                                placeholder={t('server.serverNamePlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                editable={!props.isValidating}
                            />
                        </>
                    )}

                    {props.error && (
                        <Text style={styles.errorText}>
                            {props.error}
                        </Text>
                    )}
                    {props.isValidating && (
                        <Text style={styles.validatingText}>
                            {t('server.validatingServer')}
                        </Text>
                    )}
                    <View style={styles.buttonRow}>
                        <View style={styles.buttonWrapper}>
                            <RoundButton
                                title={t('server.resetToDefault')}
                                size="normal"
                                display="inverted"
                                onPress={props.onResetServer}
                            />
                        </View>
                        <View style={styles.buttonWrapper}>
                            <RoundButton
                                title={props.isValidating
                                    ? t('server.validating')
                                    : props.autoMode
                                        ? t('server.useThisServer')
                                        : t('server.addAndUse')}
                                size="normal"
                                action={async () => {
                                    await props.onAddServer();
                                }}
                                disabled={props.isValidating}
                            />
                        </View>
                    </View>
                </View>
            ) : null}

            <Item
                title={t('server.addServerGroupTitle')}
                subtitle={t('server.addServerGroupSubtitle')}
                icon={<Ionicons name="albums-outline" size={20} color={theme.colors.textSecondary} />}
                rightElement={(
                    <Ionicons
                        name={expanded === 'group' ? 'chevron-up' : 'chevron-down'}
                        size={18}
                        color={theme.colors.textSecondary}
                    />
                )}
                showChevron={false}
                onPress={() => toggleExpanded('group')}
            />
            {expanded === 'group' ? (
                <View style={styles.contentContainer}>
                    <Text style={styles.labelText}>{t('server.serverGroupNameLabel').toUpperCase()}</Text>
                    <TextInput
                        style={[
                            styles.textInput,
                            isSavingGroup && styles.textInputValidating,
                        ]}
                        value={groupName}
                        onChangeText={setGroupName}
                        placeholder={t('server.serverGroupNamePlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                        editable={!isSavingGroup}
                    />

                    <Text style={styles.labelText}>{t('server.serverGroupServersLabel').toUpperCase()}</Text>
                    {props.servers.map((server) => {
                        const selected = selectedGroupServerIds.includes(server.id);
                        return (
                            <Item
                                key={`group-add-${server.id}`}
                                title={server.name}
                                subtitle={toServerUrlDisplay(server.serverUrl)}
                                icon={<Ionicons name="server-outline" size={18} color={theme.colors.textSecondary} />}
                                rightElement={(
                                    <Ionicons
                                        name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                                        size={18}
                                        color={selected ? theme.colors.status.connected : theme.colors.textSecondary}
                                    />
                                )}
                                showChevron={false}
                                onPress={() => handleToggleGroupServer(server.id)}
                            />
                        );
                    })}

                    <View style={styles.buttonRow}>
                        <View style={styles.buttonWrapper}>
                            <RoundButton
                                title={t('common.cancel')}
                                size="normal"
                                display="inverted"
                                onPress={() => {
                                    setGroupName('');
                                    setGroupServerIds([]);
                                    setExpanded(null);
                                }}
                            />
                        </View>
                        <View style={styles.buttonWrapper}>
                            <RoundButton
                                title={isSavingGroup ? t('common.loading') : t('server.saveServerGroup')}
                                size="normal"
                                action={handleSaveGroup}
                                disabled={isSavingGroup || groupName.trim().length === 0 || selectedGroupServerIds.length === 0}
                            />
                        </View>
                    </View>
                </View>
            ) : null}
        </ItemGroup>
    );
}

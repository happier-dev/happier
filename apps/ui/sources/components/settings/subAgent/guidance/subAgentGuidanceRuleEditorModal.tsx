import * as React from 'react';
import { Platform, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { AgentId } from '@/agents/catalog/catalog';
import { getAgentCore, isAgentId } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { Item } from '@/components/ui/lists/Item';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { getModelOptionsForAgentType } from '@/sync/domains/models/modelOptions';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { ExecutionRunsGuidanceEntry } from '@/sync/domains/settings/executionRunsGuidance';
import { t } from '@/text';

import type { SubAgentGuidanceRuleEditorResult } from './showSubAgentGuidanceRuleEditorModal';

type Intent = 'review' | 'plan' | 'delegate';

function toIntent(raw: unknown): Intent | undefined {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (v === 'review' || v === 'plan' || v === 'delegate') return v;
    return undefined;
}

function normalizeText(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

export function SubAgentGuidanceRuleEditorModal(props: Readonly<{
    mode: 'create' | 'edit';
    entry: ExecutionRunsGuidanceEntry;
    onResolve: (value: SubAgentGuidanceRuleEditorResult | null) => void;
    onClose: () => void;
}>) {
    const { theme } = useUnistyles();
    const windowDimensions = useWindowDimensions();
    const enabledAgentIds = useEnabledAgentIds();
    const popoverBoundaryRef = React.useRef<View>(null);
    const [openPicker, setOpenPicker] = React.useState<null | 'backend' | 'model' | 'intent'>(null);

    const [enabled, setEnabled] = React.useState(props.entry.enabled !== false);
    const [title, setTitle] = React.useState<string>(normalizeText(props.entry.title));
    const [description, setDescription] = React.useState<string>(normalizeText(props.entry.description));
    const [intent, setIntent] = React.useState<Intent | undefined>(toIntent(props.entry.suggestedIntent));
    const [backendId, setBackendId] = React.useState<AgentId | undefined>(() => {
        const raw = props.entry.suggestedBackendId;
        if (typeof raw !== 'string') return undefined;
        const trimmed = raw.trim();
        return trimmed && isAgentId(trimmed as any) ? (trimmed as AgentId) : undefined;
    });
    const [modelId, setModelId] = React.useState<ModelMode | undefined>(() => {
        const raw = props.entry.suggestedModelId;
        return typeof raw === 'string' && raw.trim().length > 0 ? (raw.trim() as ModelMode) : undefined;
    });
    const [exampleToolCalls, setExampleToolCalls] = React.useState<string>(
        Array.isArray(props.entry.exampleToolCalls) ? props.entry.exampleToolCalls.join('\n') : '',
    );

    const modelOptions = React.useMemo(() => {
        if (!backendId) return [];
        return getModelOptionsForAgentType(backendId).map((opt) => ({
            id: opt.value,
            title: opt.label,
            subtitle: opt.description,
        }));
    }, [backendId]);

    const canSave = description.trim().length > 0;

    const modalWidth = React.useMemo(() => {
        const raw = Number(windowDimensions?.width ?? 0);
        if (!Number.isFinite(raw) || raw <= 0) return 640;
        return Math.min(640, Math.max(320, Math.floor(raw * 0.94)));
    }, [windowDimensions?.width]);

    const modalMaxHeight = React.useMemo(() => {
        const raw = Number(windowDimensions?.height ?? 0);
        if (!Number.isFinite(raw) || raw <= 0) return 760;
        return Math.min(760, Math.max(360, Math.floor(raw * 0.92)));
    }, [windowDimensions?.height]);

    const save = React.useCallback(() => {
        if (!canSave) return;
        const next: ExecutionRunsGuidanceEntry = {
            id: props.entry.id,
            description: description.trim(),
            ...(enabled ? {} : { enabled: false }),
            ...(title.trim().length > 0 ? { title: title.trim() } : {}),
            ...(intent ? { suggestedIntent: intent } : {}),
            ...(backendId ? { suggestedBackendId: backendId } : {}),
            ...(modelId ? { suggestedModelId: modelId } : {}),
            ...(exampleToolCalls.trim().length > 0
                ? { exampleToolCalls: exampleToolCalls.split('\n').map((l) => l.trim()).filter(Boolean) }
                : {}),
        };
        props.onResolve({ kind: 'save', entry: next });
    }, [backendId, canSave, description, enabled, exampleToolCalls, intent, modelId, props, title]);

    const containerStyle = {
        backgroundColor: theme.colors.surfaceHigh ?? theme.colors.surface,
        borderRadius: 14,
        width: modalWidth,
        maxHeight: modalMaxHeight,
        overflow: 'hidden' as const,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 5,
    };

    const fieldInputStyle = {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ web: 10, ios: 8, default: 10 }) as any,
        color: theme.colors.text,
        backgroundColor: theme.colors.input.background,
    };

    const sectionLabelStyle = {
        fontSize: 13,
        fontWeight: '600' as const,
        color: theme.colors.textSecondary,
    };

    const cardStyle = {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden' as const,
    };

    return (
        <View ref={popoverBoundaryRef} style={containerStyle}>
            <View
                style={{
                    paddingHorizontal: 20,
                    paddingTop: 16,
                    paddingBottom: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: theme.colors.divider,
                    backgroundColor: theme.colors.surface,
                }}
            >
                <Text style={{ fontSize: 16, color: theme.colors.text, fontWeight: '600' }}>
                    {props.mode === 'create' ? 'New rule' : 'Edit rule'}
                </Text>
            </View>

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
                <View style={cardStyle}>
                    <Item
                        title="Enabled"
                        subtitle={enabled ? 'Enabled' : 'Disabled'}
                        icon={<Ionicons name="sparkles-outline" size={24} color="#FF9500" />}
                        rightElement={<Switch value={enabled} onValueChange={setEnabled} />}
                        showChevron={false}
                        showDivider={false}
                        onPress={() => setEnabled(!enabled)}
                    />
                </View>

                <View style={cardStyle}>
                    <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
                        <Text style={sectionLabelStyle}>Title (optional)</Text>
                    </View>
                    <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12 }}>
                        <TextInput
                            style={[fieldInputStyle, Typography.default()]}
                            placeholder="e.g. UI work"
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={title}
                            onChangeText={setTitle}
                        />
                    </View>
                </View>

                <View style={cardStyle}>
                    <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
                        <Text style={sectionLabelStyle}>When should the agent delegate?</Text>
                    </View>
                    <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12 }}>
                        <TextInput
                            style={[fieldInputStyle, Typography.default(), { minHeight: 92 }]}
                            placeholder="Describe when/how to delegate…"
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={description}
                            onChangeText={setDescription}
                            multiline={true}
                        />
                    </View>
                </View>

                <DropdownMenu
                    open={openPicker === 'backend'}
                    onOpenChange={(next) => setOpenPicker(next ? 'backend' : null)}
                    variant="selectable"
                    search={true}
                    searchPlaceholder="Search backends"
                    selectedId={backendId ?? ''}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    trigger={({ open, toggle }) => (
                        <View style={cardStyle}>
                            <Item
                                title="Target backend (optional)"
                                subtitle={backendId ?? 'No preference'}
                                icon={<Ionicons name="hardware-chip-outline" size={24} color={theme.colors.textSecondary} />}
                                rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={theme.colors.textSecondary} />}
                                onPress={toggle}
                                showChevron={false}
                                showDivider={false}
                            />
                        </View>
                    )}
                    items={[
                        {
                            id: '',
                            title: 'No preference',
                            subtitle: 'Let the agent choose a backend.',
                            icon: (
                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                    <Ionicons name="remove-circle-outline" size={22} color={theme.colors.textSecondary} />
                                </View>
                            ),
                        },
                        ...enabledAgentIds.map((id) => ({
                            id,
                            title: t(getAgentCore(id as any).displayNameKey),
                            subtitle: String(id),
                            icon: (
                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                    <Ionicons name="sparkles-outline" size={22} color={theme.colors.textSecondary} />
                                </View>
                            ),
                        })),
                    ]}
                    onSelect={(id) => {
                        const next = String(id ?? '').trim();
                        if (!next) {
                            setBackendId(undefined);
                            setModelId(undefined);
                            return;
                        }
                        if (isAgentId(next as any)) {
                            setBackendId(next as any);
                            setModelId(undefined);
                        }
                    }}
                />

                {backendId ? (
                    <DropdownMenu
                        open={openPicker === 'model'}
                        onOpenChange={(next) => setOpenPicker(next ? 'model' : null)}
                        variant="selectable"
                        search={true}
                        searchPlaceholder="Search models"
                        selectedId={modelId ?? ''}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        trigger={({ open, toggle }) => (
                            <View style={cardStyle}>
                                <Item
                                    title="Target model (optional)"
                                    subtitle={modelId ?? 'No preference'}
                                    icon={<Ionicons name="layers-outline" size={24} color={theme.colors.textSecondary} />}
                                    rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={theme.colors.textSecondary} />}
                                    onPress={toggle}
                                    showChevron={false}
                                    showDivider={false}
                                />
                            </View>
                        )}
                        items={[
                            {
                                id: '',
                                title: 'No preference',
                                subtitle: 'Let the backend pick a default model.',
                                icon: (
                                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                        <Ionicons name="remove-circle-outline" size={22} color={theme.colors.textSecondary} />
                                    </View>
                                ),
                            },
                            ...modelOptions.map((opt) => ({
                                id: opt.id,
                                title: opt.title,
                                subtitle: opt.subtitle,
                                icon: (
                                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                        <Ionicons name="layers-outline" size={22} color={theme.colors.textSecondary} />
                                    </View>
                                ),
                            })),
                        ]}
                        onSelect={(id) => {
                            const next = String(id ?? '').trim();
                            setModelId(next ? (next as any) : undefined);
                        }}
                    />
                ) : null}

                <DropdownMenu
                    open={openPicker === 'intent'}
                    onOpenChange={(next) => setOpenPicker(next ? 'intent' : null)}
                    variant="selectable"
                    search={false}
                    selectedId={intent ?? ''}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    trigger={({ open, toggle }) => (
                        <View style={cardStyle}>
                            <Item
                                title="Suggested intent (optional)"
                                subtitle={intent ?? 'No preference'}
                                icon={<Ionicons name="navigate-outline" size={24} color={theme.colors.textSecondary} />}
                                rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={theme.colors.textSecondary} />}
                                onPress={toggle}
                                showChevron={false}
                                showDivider={false}
                            />
                        </View>
                    )}
                    items={[
                        { id: '', title: 'No preference', subtitle: 'Let the agent decide intent.' },
                        { id: 'review', title: 'review', subtitle: 'Code review / findings.' },
                        { id: 'plan', title: 'plan', subtitle: 'Planning / architecture.' },
                        { id: 'delegate', title: 'delegate', subtitle: 'Delegation / execution.' },
                    ].map((it) => ({
                        ...it,
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="navigate-outline" size={22} color={theme.colors.textSecondary} />
                            </View>
                        ),
                    }))}
                    onSelect={(id) => {
                        const next = String(id ?? '').trim();
                        setIntent(next ? (next as any) : undefined);
                    }}
                />

                <View style={cardStyle}>
                    <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
                        <Text style={sectionLabelStyle}>Example tool calls (optional, one per line)</Text>
                    </View>
                    <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12 }}>
                        <TextInput
                            style={[fieldInputStyle, Typography.default(), { minHeight: 92 }]}
                            placeholder="execution.run.start …"
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={exampleToolCalls}
                            onChangeText={setExampleToolCalls}
                            multiline={true}
                        />
                    </View>
                </View>
            </ScrollView>

            <View
                style={{
                    borderTopWidth: 1,
                    borderTopColor: theme.colors.divider,
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    backgroundColor: theme.colors.surface,
                }}
            >
                <View style={{ flexDirection: 'row', gap: 10 }}>
                    <RoundButton size="normal" display="inverted" title="Cancel" onPress={() => props.onResolve(null)} />
                    {props.mode === 'edit' ? (
                        <RoundButton
                            size="normal"
                            display="inverted"
                            title="Delete"
                            textStyle={{ color: theme.colors.textDestructive }}
                            onPress={() => props.onResolve({ kind: 'delete' })}
                        />
                    ) : null}
                </View>
                <RoundButton size="normal" title="Save" disabled={!canSave} onPress={save} />
            </View>
        </View>
    );
}

import * as React from 'react';
import { Platform, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import type { AgentId } from '@/agents/catalog/catalog';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/StyledText';
import { randomUUID } from '@/platform/randomUUID';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { AGENT_IDS } from '@/agents/catalog/catalog';
import { getModelOptionsForAgentType } from '@/sync/domains/models/modelOptions';
import { getAgentCore } from '@/agents/catalog/catalog';

export type ExecutionRunsGuidanceEntry = Readonly<{
    id: string;
    title?: string;
    description: string;
    enabled?: boolean;
    suggestedIntent?: 'review' | 'plan' | 'delegate';
    suggestedBackendId?: AgentId;
    suggestedModelId?: ModelMode;
    exampleToolCalls?: readonly string[];
}>;

function updateEntry<T extends ExecutionRunsGuidanceEntry>(
    entries: readonly T[],
    id: string,
    patch: Partial<T>,
): readonly T[] {
    return entries.map((e) => (e.id === id ? ({ ...e, ...patch } as T) : e));
}

function removeEntry<T extends ExecutionRunsGuidanceEntry>(entries: readonly T[], id: string): readonly T[] {
    return entries.filter((e) => e.id !== id);
}

export const ExecutionRunsGuidanceSettingsGroup = React.memo((props: Readonly<{
    enabled: boolean;
    setEnabled: (next: boolean) => void;
    maxChars: number;
    setMaxChars: (next: number) => void;
    entries: readonly ExecutionRunsGuidanceEntry[];
    setEntries: (next: readonly ExecutionRunsGuidanceEntry[]) => void;
}>) => {
    const { theme } = useUnistyles();
    const [advancedOpenById, setAdvancedOpenById] = React.useState<Record<string, boolean>>({});

    const addRule = React.useCallback(() => {
        const id = `guidance_${randomUUID()}`;
        props.setEntries([
            ...(Array.isArray(props.entries) ? props.entries : []),
            { id, description: '', enabled: true },
        ]);
    }, [props]);

    return (
        <ItemGroup
            title="Sub-agent"
            footer="Optional rules appended to the system prompt to guide when/how the agent should launch sub-agents."
        >
            <Item
                title="Enable guidance injection"
                subtitle={props.enabled ? 'Enabled' : 'Disabled'}
                icon={<Ionicons name="sparkles-outline" size={29} color="#FF9500" />}
                rightElement={<Switch value={Boolean(props.enabled)} onValueChange={props.setEnabled} />}
                showChevron={false}
                onPress={() => props.setEnabled(!props.enabled)}
            />

            {props.enabled ? (
                <>
                    <View style={{ paddingHorizontal: 16, paddingTop: 0, gap: 6 }}>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.textSecondary }}>
                            Max characters
                        </Text>
                        <TextInput
                            style={{
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                                borderRadius: 10,
                                paddingHorizontal: 12,
                                paddingVertical: Platform.select({ web: 10, ios: 8, default: 10 }) as any,
                                color: theme.colors.text,
                            }}
                            placeholder="4000"
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={String(props.maxChars ?? '')}
                            keyboardType={Platform.select({ ios: 'number-pad', default: 'numeric' }) as any}
                            onChangeText={(value) => {
                                const next = Number(String(value).replace(/[^0-9]/g, ''));
                                if (!Number.isFinite(next)) return;
                                const clamped = Math.max(200, Math.min(50_000, Math.floor(next)));
                                props.setMaxChars(clamped as any);
                            }}
                        />
                    </View>

                    <Item
                        title="Add rule"
                        subtitle="Add a delegation rule"
                        icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.textSecondary} />}
                        onPress={addRule}
                    />

                    {(props.entries ?? []).map((entry) => (
                        <View key={entry.id} style={{ paddingHorizontal: 16, paddingTop: 0, gap: 10 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.textSecondary }}>
                                    Rule
                                </Text>
                                <Switch
                                    value={entry.enabled !== false}
                                    onValueChange={(next) => {
                                        props.setEntries(updateEntry(props.entries, entry.id, { enabled: next } as any));
                                    }}
                                />
                            </View>
                            <TextInput
                                style={{
                                    borderWidth: 1,
                                    borderColor: theme.colors.divider,
                                    borderRadius: 10,
                                    paddingHorizontal: 12,
                                    paddingVertical: 10,
                                    minHeight: 44,
                                    color: theme.colors.text,
                                }}
                                placeholder="Describe when to delegate"
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={String(entry.description ?? '')}
                                multiline={true}
                                onChangeText={(value) => {
                                    props.setEntries(updateEntry(props.entries, entry.id, { description: String(value) } as any));
                                }}
                            />

                            <BackendPickerRow
                                value={entry.suggestedBackendId}
                                onChange={(next) => {
                                    // When backend changes, drop model unless it still looks valid.
                                    props.setEntries(updateEntry(props.entries, entry.id, {
                                        suggestedBackendId: next,
                                        suggestedModelId: undefined,
                                    } as any));
                                }}
                            />

                            {entry.suggestedBackendId ? (
                                <ModelPickerRow
                                    backendId={entry.suggestedBackendId}
                                    value={entry.suggestedModelId}
                                    onChange={(next) => {
                                        props.setEntries(updateEntry(props.entries, entry.id, { suggestedModelId: next } as any));
                                    }}
                                />
                            ) : null}

                            <Item
                                title="Advanced options"
                                subtitle="Title, intent, and example tool calls"
                                icon={<Ionicons name="options-outline" size={24} color={theme.colors.textSecondary} />}
                                rightElement={
                                    <Ionicons
                                        name={advancedOpenById[entry.id] ? 'chevron-up' : 'chevron-down'}
                                        size={20}
                                        color={theme.colors.textSecondary}
                                    />
                                }
                                onPress={() => {
                                    setAdvancedOpenById((prev) => ({ ...prev, [entry.id]: !prev[entry.id] }));
                                }}
                                showChevron={false}
                                selected={false}
                            />

                            {advancedOpenById[entry.id] ? (
                                <View style={{ gap: 10 }}>
                                    <TextInput
                                        style={{
                                            borderWidth: 1,
                                            borderColor: theme.colors.divider,
                                            borderRadius: 10,
                                            paddingHorizontal: 12,
                                            paddingVertical: Platform.select({ web: 10, ios: 8, default: 10 }) as any,
                                            color: theme.colors.text,
                                        }}
                                        placeholder="Optional title"
                                        placeholderTextColor={theme.colors.input.placeholder}
                                        value={String(entry.title ?? '')}
                                        onChangeText={(value) => {
                                            const next = String(value ?? '').trim();
                                            props.setEntries(updateEntry(props.entries, entry.id, { title: next.length > 0 ? next : undefined } as any));
                                        }}
                                    />

                                    <IntentPickerRow
                                        value={entry.suggestedIntent}
                                        onChange={(next) => {
                                            props.setEntries(updateEntry(props.entries, entry.id, { suggestedIntent: next } as any));
                                        }}
                                    />

                                    <TextInput
                                        style={{
                                            borderWidth: 1,
                                            borderColor: theme.colors.divider,
                                            borderRadius: 10,
                                            paddingHorizontal: 12,
                                            paddingVertical: 10,
                                            minHeight: 44,
                                            color: theme.colors.text,
                                        }}
                                        placeholder="Example tool calls (one per line)"
                                        placeholderTextColor={theme.colors.input.placeholder}
                                        value={Array.isArray(entry.exampleToolCalls) ? entry.exampleToolCalls.join('\n') : ''}
                                        multiline={true}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        onChangeText={(value) => {
                                            const lines = String(value ?? '')
                                                .split('\n')
                                                .map((line) => line.trim())
                                                .filter(Boolean);
                                            props.setEntries(updateEntry(props.entries, entry.id, {
                                                exampleToolCalls: lines.length > 0 ? lines : undefined,
                                            } as any));
                                        }}
                                    />
                                </View>
                            ) : null}

                            <Item
                                title="Remove rule"
                                subtitle="Delete this rule"
                                icon={<Ionicons name="trash-outline" size={24} color={theme.colors.textSecondary} />}
                                onPress={() => props.setEntries(removeEntry(props.entries, entry.id))}
                            />
                        </View>
                    ))}
                </>
            ) : null}
        </ItemGroup>
    );
});

function BackendPickerRow(props: Readonly<{
    value: AgentId | undefined;
    onChange: (next: AgentId | undefined) => void;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);

    const items = React.useMemo(() => {
        return [
            { id: 'none', title: 'No backend', subtitle: 'Do not suggest a backend' },
            ...AGENT_IDS.map((id) => ({ id, title: id, subtitle: getAgentCore(id).connectedService.name })),
        ];
    }, []);

    const selectedId = props.value ?? 'none';

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            search={true}
            rowKind="item"
            matchTriggerWidth={true}
            connectToTrigger={true}
            selectedId={selectedId}
            items={items as any}
            onSelect={(id) => {
                if (id === 'none') props.onChange(undefined);
                else props.onChange(id as AgentId);
                setOpen(false);
            }}
            trigger={({ toggle, open }) => (
                <Item
                    title="Backend"
                    subtitle={props.value ? String(props.value) : 'None'}
                    icon={<Ionicons name="sparkles-outline" size={24} color={theme.colors.textSecondary} />}
                    rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                    onPress={toggle}
                    showChevron={false}
                    selected={false}
                />
            )}
        />
    );
}

function ModelPickerRow(props: Readonly<{
    backendId: AgentId;
    value: ModelMode | undefined;
    onChange: (next: ModelMode | undefined) => void;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);

    const core = getAgentCore(props.backendId);
    const options = React.useMemo(() => getModelOptionsForAgentType(props.backendId), [props.backendId]);
    if (core.model.supportsSelection !== true) return null;

    const items = React.useMemo(() => {
        // If freeform is supported, the dropdown is a convenience; the user can still type below.
        const base = options.map((opt) => ({
            id: String(opt.value),
            title: String(opt.label),
            subtitle: String(opt.description ?? ''),
        }));
        return base.length > 0 ? base : [{ id: 'default', title: 'default', subtitle: '' }];
    }, [options]);

    const selectedId = props.value ?? 'default';

    return (
        <View style={{ gap: 6 }}>
            <DropdownMenu
                open={open}
                onOpenChange={setOpen}
                search={true}
                rowKind="item"
                matchTriggerWidth={true}
                connectToTrigger={true}
                selectedId={selectedId}
                items={items as any}
                onSelect={(id) => {
                    props.onChange(id as any);
                    setOpen(false);
                }}
                trigger={({ toggle, open }) => (
                    <Item
                        title="Model"
                        subtitle={props.value ? String(props.value) : 'default'}
                        icon={<Ionicons name="layers-outline" size={24} color={theme.colors.textSecondary} />}
                        rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                        onPress={toggle}
                        showChevron={false}
                        selected={false}
                    />
                )}
            />

            {core.model.supportsFreeform ? (
                <TextInput
                    style={{
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        borderRadius: 10,
                        paddingHorizontal: 12,
                        paddingVertical: Platform.select({ web: 10, ios: 8, default: 10 }) as any,
                        color: theme.colors.text,
                    }}
                    placeholder="Custom model id (optional)"
                    placeholderTextColor={theme.colors.input.placeholder}
                    value={String(props.value ?? '')}
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={(value) => {
                        const next = String(value ?? '').trim();
                        props.onChange(next.length > 0 ? (next as any) : undefined);
                    }}
                />
            ) : null}
        </View>
    );
}

function IntentPickerRow(props: Readonly<{
    value: ExecutionRunsGuidanceEntry['suggestedIntent'] | undefined;
    onChange: (next: ExecutionRunsGuidanceEntry['suggestedIntent'] | undefined) => void;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);

    const items = React.useMemo(
        () => [
            { id: 'none', title: 'No intent', subtitle: 'Do not suggest an intent' },
            { id: 'review', title: 'review', subtitle: 'Prefer using review intent' },
            { id: 'plan', title: 'plan', subtitle: 'Prefer using plan intent' },
            { id: 'delegate', title: 'delegate', subtitle: 'Prefer using delegate intent' },
        ],
        [],
    );

    const selectedId = props.value ?? 'none';

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            search={false}
            rowKind="item"
            matchTriggerWidth={true}
            connectToTrigger={true}
            selectedId={selectedId}
            items={items as any}
            onSelect={(id) => {
                if (id === 'none') props.onChange(undefined);
                else props.onChange(id as any);
                setOpen(false);
            }}
            trigger={({ toggle, open }) => (
                <Item
                    title="Intent"
                    subtitle={props.value ? String(props.value) : 'None'}
                    icon={<Ionicons name="sparkles-outline" size={24} color={theme.colors.textSecondary} />}
                    rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                    onPress={toggle}
                    showChevron={false}
                    selected={false}
                />
            )}
        />
    );
}

import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getModelDropdownMenuItems, REFRESH_MODELS_DROPDOWN_ITEM_ID } from '@/components/settings/pickers/modelDropdownItems';
import { Item } from '@/components/ui/lists/Item';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { ExecutionRunsGuidanceEntry } from '@/sync/domains/settings/executionRunsGuidance';
import { t } from '@/text';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useAllMachines } from '@/sync/store/hooks';
import { useSetting } from '@/sync/domains/state/storage';
import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

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
}> & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const enabledAgentIds = useEnabledAgentIds();
    const popoverBoundaryRef = React.useRef<View>(null);
    const [openPicker, setOpenPicker] = React.useState<null | 'backend' | 'model' | 'intent'>(null);

    const [enabled, setEnabled] = React.useState(props.entry.enabled !== false);
    const [title, setTitle] = React.useState<string>(normalizeText(props.entry.title));
    const [description, setDescription] = React.useState<string>(normalizeText(props.entry.description));
    const [intent, setIntent] = React.useState<Intent | undefined>(toIntent(props.entry.suggestedIntent));
    const [backendTarget, setBackendTarget] = React.useState<BackendTargetRefV1 | undefined>(() => {
        const raw = props.entry.suggestedBackendTarget;
        return raw ?? undefined;
    });
    const [modelId, setModelId] = React.useState<ModelMode | undefined>(() => {
        const raw = props.entry.suggestedModelId;
        return typeof raw === 'string' && raw.trim().length > 0 ? (raw.trim() as ModelMode) : undefined;
    });
    const [exampleToolCalls, setExampleToolCalls] = React.useState<string>(
        Array.isArray(props.entry.exampleToolCalls) ? props.entry.exampleToolCalls.join('\n') : '',
    );

    const canSave = description.trim().length > 0;
    const machines = useAllMachines();
    const recentMachinePaths = useSetting('recentMachinePaths') as any[] | undefined;
    const acpCatalogSettingsV1 = useSetting('acpCatalogSettingsV1');
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const preflightMachineId = React.useMemo(() => {
        return resolvePreferredMachineId({
            machines,
            recentMachinePaths: Array.isArray(recentMachinePaths) ? recentMachinePaths : [],
        });
    }, [machines, recentMachinePaths]);

    const backendEntries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSettingsV1: acpCatalogSettingsV1 as any,
            backendEnabledByTargetKey: backendEnabledByTargetKey as Record<string, boolean> | undefined,
        });
    }, [acpCatalogSettingsV1, backendEnabledByTargetKey, enabledAgentIds]);

    const selectedBackendEntry = React.useMemo(() => {
        if (!backendTarget) return null;
        return backendEntries.find((entry) => entry.targetKey === buildBackendTargetKey(backendTarget)) ?? null;
    }, [backendEntries, backendTarget]);

    const preflightModels = useNewSessionPreflightModelsState({
        backendTarget: backendTarget ?? { kind: 'builtInAgent', agentId: DEFAULT_AGENT_ID },
        selectedMachineId: backendTarget ? preflightMachineId : null,
        capabilityServerId: String(getActiveServerSnapshot().serverId ?? '').trim(),
    });

    const save = React.useCallback(() => {
        if (!canSave) return;
        const next: ExecutionRunsGuidanceEntry = {
            id: props.entry.id,
            description: description.trim(),
            ...(enabled ? {} : { enabled: false }),
            ...(title.trim().length > 0 ? { title: title.trim() } : {}),
            ...(intent ? { suggestedIntent: intent } : {}),
            ...(backendTarget ? { suggestedBackendTarget: backendTarget } : {}),
            ...(modelId ? { suggestedModelId: modelId } : {}),
            ...(exampleToolCalls.trim().length > 0
                ? { exampleToolCalls: exampleToolCalls.split('\n').map((l) => l.trim()).filter(Boolean) }
                : {}),
        };
        props.onResolve({ kind: 'save', entry: next });
        props.onClose();
    }, [backendTarget, canSave, description, enabled, exampleToolCalls, intent, modelId, props, title]);

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

    const enabledSubtitle = enabled
        ? t('subAgentGuidance.ruleEditor.enabledState.enabled')
        : t('subAgentGuidance.ruleEditor.enabledState.disabled');

    const intentSubtitle = (() => {
        if (!intent) return t('subAgentGuidance.ruleEditor.common.noPreference');
        switch (intent) {
            case 'review':
                return t('subAgentGuidance.ruleEditor.intent.options.review.title');
            case 'plan':
                return t('subAgentGuidance.ruleEditor.intent.options.plan.title');
            case 'delegate':
                return t('subAgentGuidance.ruleEditor.intent.options.delegate.title');
            default:
                return String(intent);
        }
    })();

    const footer = React.useMemo(() => (
        <View
            style={{
                paddingHorizontal: 16,
                paddingVertical: 12,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
            }}
        >
            <View style={{ flexDirection: 'row', gap: 10 }}>
                <RoundButton
                    size="normal"
                    display="inverted"
                    title={t('common.cancel')}
                    onPress={() => {
                        props.onResolve(null);
                        props.onClose();
                    }}
                />
                {props.mode === 'edit' ? (
                    <RoundButton
                        size="normal"
                        display="inverted"
                        title={t('common.delete')}
                        textStyle={{ color: theme.colors.textDestructive }}
                        onPress={() => {
                            props.onResolve({ kind: 'delete' });
                            props.onClose();
                        }}
                    />
                ) : null}
            </View>
            <RoundButton size="normal" title={t('common.save')} disabled={!canSave} onPress={save} />
        </View>
    ), [canSave, props, save, theme.colors.textDestructive]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: props.mode === 'create'
            ? t('subAgentGuidance.ruleEditor.header.newRule')
            : t('subAgentGuidance.ruleEditor.header.editRule'),
        testID: 'sub-agent-guidance-rule-editor-modal',
        layout: 'fill' as const,
        dimensions: { width: 640, maxHeightRatio: 0.92, size: 'lg' as const },
        footer,
    }), [footer, props.mode]);

    useModalCardChrome(props.setChrome, chrome);

    return (
        <View ref={popoverBoundaryRef} style={{ flex: 1, minHeight: 0 }}>
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
                        title={t('subAgentGuidance.ruleEditor.enabled.title')}
                        subtitle={enabledSubtitle}
                        icon={<Ionicons name="sparkles-outline" size={24} color={theme.colors.accent.orange} />}
                        rightElement={<Switch value={enabled} onValueChange={setEnabled} />}
                        showChevron={false}
                        showDivider={false}
                        onPress={() => setEnabled(!enabled)}
                    />
                </View>

                <View style={cardStyle}>
                    <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
                        <Text style={sectionLabelStyle}>{t('subAgentGuidance.ruleEditor.titleField.label')}</Text>
                    </View>
                    <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12 }}>
                        <TextInput
                            style={[fieldInputStyle, Typography.default()]}
                            placeholder={t('subAgentGuidance.ruleEditor.titleField.placeholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={title}
                            onChangeText={setTitle}
                        />
                    </View>
                </View>

                <View style={cardStyle}>
                    <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
                        <Text style={sectionLabelStyle}>{t('subAgentGuidance.ruleEditor.descriptionField.label')}</Text>
                    </View>
                    <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12 }}>
                        <TextInput
                            style={[fieldInputStyle, Typography.default(), { minHeight: 92 }]}
                            placeholder={t('subAgentGuidance.ruleEditor.descriptionField.placeholder')}
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
                    searchPlaceholder={t('subAgentGuidance.ruleEditor.backendPicker.searchPlaceholder')}
                    selectedId={selectedBackendEntry?.targetKey ?? ''}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    trigger={({ open, toggle }) => (
                        <View style={cardStyle}>
                            <Item
                                title={t('subAgentGuidance.ruleEditor.backendPicker.title')}
                                subtitle={selectedBackendEntry?.title ?? t('subAgentGuidance.ruleEditor.common.noPreference')}
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
                              title: t('subAgentGuidance.ruleEditor.common.noPreference'),
                              subtitle: t('subAgentGuidance.ruleEditor.backendPicker.noPreference.subtitle'),
                            icon: (
                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                    <Ionicons name="remove-circle-outline" size={22} color={theme.colors.textSecondary} />
                                </View>
                              ),
                          },
                          ...backendEntries.map((entry) => ({
                              id: entry.targetKey,
                              title: entry.title,
                              subtitle: entry.subtitle ?? undefined,
                              icon: (
                                  <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                      <Ionicons name="hardware-chip-outline" size={22} color={theme.colors.textSecondary} />
                                  </View>
                              ),
                          })),
                      ]}
                      onSelect={(id) => {
                        const next = String(id ?? '').trim();
                        if (!next) {
                            setBackendTarget(undefined);
                            setModelId(undefined);
                            return;
                        }
                        const resolved = backendEntries.find((entry) => entry.targetKey === next) ?? null;
                        if (!resolved) return;
                        setBackendTarget(resolved.target);
                        setModelId(undefined);
                    }}
                />

                {backendTarget ? (
                    <DropdownMenu
                        open={openPicker === 'model'}
                        onOpenChange={(next) => setOpenPicker(next ? 'model' : null)}
                        variant="selectable"
                        search={true}
                        searchPlaceholder={t('subAgentGuidance.ruleEditor.modelPicker.searchPlaceholder')}
                        selectedId={modelId ?? ''}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        trigger={({ open, toggle }) => (
                            <View style={cardStyle}>
                                <Item
                                    title={t('subAgentGuidance.ruleEditor.modelPicker.title')}
                                    subtitle={modelId ?? t('subAgentGuidance.ruleEditor.common.noPreference')}
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
                                  title: t('subAgentGuidance.ruleEditor.common.noPreference'),
                                  subtitle: t('subAgentGuidance.ruleEditor.modelPicker.noPreference.subtitle'),
                                icon: (
                                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                        <Ionicons name="remove-circle-outline" size={22} color={theme.colors.textSecondary} />
                                    </View>
                                  ),
                              },
                              ...getModelDropdownMenuItems({
                                    modelOptions: preflightModels.modelOptions,
                                    iconColor: theme.colors.textSecondary,
                                    probe: {
                                        phase: preflightModels.probe.phase,
                                        onRefresh: preflightModels.probe.onRefresh,
                                    },
                        }),
                          ]}
                          onSelect={(id) => {
                            if (id === REFRESH_MODELS_DROPDOWN_ITEM_ID) {
                                preflightModels.probe.onRefresh?.();
                                return;
                            }
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
                                title={t('subAgentGuidance.ruleEditor.intent.title')}
                                subtitle={intentSubtitle}
                                icon={<Ionicons name="navigate-outline" size={24} color={theme.colors.textSecondary} />}
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
                            title: t('subAgentGuidance.ruleEditor.common.noPreference'),
                            subtitle: t('subAgentGuidance.ruleEditor.intent.noPreference.subtitle'),
                        },
                        {
                            id: 'review',
                            title: t('subAgentGuidance.ruleEditor.intent.options.review.title'),
                            subtitle: t('subAgentGuidance.ruleEditor.intent.options.review.subtitle'),
                        },
                        {
                            id: 'plan',
                            title: t('subAgentGuidance.ruleEditor.intent.options.plan.title'),
                            subtitle: t('subAgentGuidance.ruleEditor.intent.options.plan.subtitle'),
                        },
                        {
                            id: 'delegate',
                            title: t('subAgentGuidance.ruleEditor.intent.options.delegate.title'),
                            subtitle: t('subAgentGuidance.ruleEditor.intent.options.delegate.subtitle'),
                        },
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
                        <Text style={sectionLabelStyle}>{t('subAgentGuidance.ruleEditor.exampleToolCalls.label')}</Text>
                    </View>
                    <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12 }}>
                        <TextInput
                            style={[fieldInputStyle, Typography.default(), { minHeight: 92 }]}
                            placeholder={t('subAgentGuidance.ruleEditor.exampleToolCalls.placeholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={exampleToolCalls}
                            onChangeText={setExampleToolCalls}
                            multiline={true}
                        />
                    </View>
                </View>
            </ScrollView>
        </View>
    );
}

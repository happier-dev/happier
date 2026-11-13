import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { buildBackendTargetKey, type VisibleAgentsTeamTemplateEntryV1 } from '@happier-dev/protocol';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';

import type { VisibleAgentBackendChoice, VisibleAgentRoleChoice } from './VisibleAgentAssignmentEditorModal';
import { showVisibleAgentAssignmentEditorModal } from './showVisibleAgentAssignmentEditorModal';

export function VisibleAgentsTeamTemplateEditorModal(props: Readonly<{
    initial: ReadonlyArray<VisibleAgentsTeamTemplateEntryV1>;
    roles: ReadonlyArray<VisibleAgentRoleChoice>;
    backends: ReadonlyArray<VisibleAgentBackendChoice>;
    onResolve: (value: ReadonlyArray<VisibleAgentsTeamTemplateEntryV1> | null) => void;
}> & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const [entries, setEntries] = React.useState<ReadonlyArray<VisibleAgentsTeamTemplateEntryV1>>(props.initial);
    const closeWith = React.useCallback((value: ReadonlyArray<VisibleAgentsTeamTemplateEntryV1> | null) => {
        props.onResolve(value);
        props.onClose();
    }, [props]);
    const footer = React.useMemo(() => (
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
            <RoundButton size="normal" display="inverted" title={t('common.cancel')} onPress={() => closeWith(null)} />
            <RoundButton size="normal" title={t('common.save')} onPress={() => closeWith(entries)} />
        </View>
    ), [closeWith, entries]);
    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: t('visibleAgents.teamTemplate.title'),
        testID: 'visible-agents-team-template-editor-modal',
        layout: 'fill' as const,
        dimensions: { width: 640, maxHeightRatio: 0.92, size: 'lg' as const },
        footer,
    }), [footer]));

    const editEntry = React.useCallback(async (index: number) => {
        const entry = entries[index];
        if (!entry) return;
        const result = await showVisibleAgentAssignmentEditorModal({
            title: t('visibleAgents.editor.editMember'),
            initial: entry,
            roles: props.roles,
            backends: props.backends,
            roleRequired: true,
            showPermissionMode: true,
        });
        if (!result?.role) return;
        setEntries((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? {
            role: result.role!,
            ...(result.backendTarget ? { backendTarget: result.backendTarget } : {}),
            ...(result.modelId ? { modelId: result.modelId } : {}),
            ...(result.permissionMode ? { permissionMode: result.permissionMode } : {}),
        } : candidate));
    }, [entries, props.backends, props.roles]);
    const addEntry = React.useCallback(async () => {
        const result = await showVisibleAgentAssignmentEditorModal({
            title: t('visibleAgents.editor.addMember'),
            initial: { role: 'worker' },
            roles: props.roles,
            backends: props.backends,
            roleRequired: true,
            showPermissionMode: true,
        });
        if (!result?.role) return;
        setEntries((current) => [...current, {
            role: result.role!,
            ...(result.backendTarget ? { backendTarget: result.backendTarget } : {}),
            ...(result.modelId ? { modelId: result.modelId } : {}),
            ...(result.permissionMode ? { permissionMode: result.permissionMode } : {}),
        }]);
    }, [props.backends, props.roles]);

    return (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 18 }}>
            <ItemGroup footer={t('visibleAgents.teamFooter')}>
                {entries.map((entry, index) => {
                    const roleLabel = props.roles.find((choice) => choice.id === entry.role)?.label ?? entry.role;
                    const backendLabel = entry.backendTarget
                        ? props.backends.find((choice) => buildBackendTargetKey(choice.target) === buildBackendTargetKey(entry.backendTarget!))?.label
                        : undefined;
                    const detail = [backendLabel, entry.modelId, entry.permissionMode].filter(Boolean).join(' · ')
                        || t('visibleAgents.editor.inheritLeadDefaults');
                    return (
                        <Item
                            key={`${index}:${entry.role}`}
                            testID={`visible-agents-team-member-${index}`}
                            title={roleLabel}
                            subtitle={detail}
                            icon={<Icon name="user-circle" size={29} color={theme.colors.accent.indigo} />}
                            onPress={() => { void editEntry(index); }}
                            rightElement={(
                                <RoundButton
                                    size="small"
                                    display="inverted"
                                    title={t('common.remove')}
                                    onPress={() => setEntries((current) => current.filter((_, candidateIndex) => candidateIndex !== index))}
                                />
                            )}
                            rightElementOutsidePressable
                        />
                    );
                })}
                <Item
                    testID="visible-agents-team-member-add"
                    title={t('visibleAgents.editor.addMember')}
                    icon={<Icon name="plus-circle" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => { void addEntry(); }}
                />
            </ItemGroup>
        </ScrollView>
    );
}

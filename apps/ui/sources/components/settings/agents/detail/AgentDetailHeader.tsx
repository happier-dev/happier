import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { resolveAgentsMachineCandidateAvailability } from '@/components/settings/agents/collection/useAgentAdministrationCatalog';
import { MachineAdministrationContextBar } from '@/components/settings/machines/MachineAdministrationContextBar';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, PageHeaderStateSwitch, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { StatusPill } from '@/components/ui/status/StatusPill';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';

export type AgentDetailEnabledControl = Readonly<{
    value: boolean | null;
    disabled: boolean;
    onChange: (next: boolean) => void;
}>;

export type AgentDetailMenuAction = PageHeaderMenuAction;

/**
 * "Managing <machine>": the machine an agent page acts on. It stays on every agent page, including
 * loading, offline and not-found states, because it is the control that recovers them.
 */
export const AgentMachineContextBar = React.memo(function AgentMachineContextBar(props: Readonly<{
    targetSelection: MachineAdministrationTargetSelectionV1;
}>) {
    return (
        <MachineAdministrationContextBar
            label={t('settingsAgents.detailPage.machineScopeLabel')}
            selection={props.targetSelection}
            resolveCandidateAvailability={resolveAgentsMachineCandidateAvailability}
            testIDPrefix="settings.agents.administration.target"
        />
    );
});

/**
 * An agent detail page's identity: its mark, name and CLI on the managed machine, with the
 * page-level controls — whether the agent is offered at all, and its less frequent actions.
 */
export const AgentDetailHeader = React.memo(function AgentDetailHeader(props: Readonly<{
    projection: ResolvedAgentCatalogEntry;
    description: string;
    machineId: string | null;
    serverId: string | null;
    identityCurrent: boolean;
    enabled: AgentDetailEnabledControl | null;
    menuActions?: readonly AgentDetailMenuAction[];
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { enabled } = props;
    return (
        <PageHeader
            testID="settings.agents.detail.header"
            alwaysShowTitle
            title={props.projection.title}
            titleAccessory={props.projection.channel === 'experimental' ? (
                <StatusPill variant="neutral" label={t('settingsAgents.channelExperimental')} hideDot labelVariant="phrase" />
            ) : undefined}
            description={props.description}
            leading={(
                <PageHeaderMarkSlot>
                    <AgentCatalogIdentityIcon
                        entry={props.projection}
                        machineId={props.machineId}
                        serverId={props.serverId}
                        current={props.identityCurrent}
                        color={theme.colors.text.secondary}
                        size={24}
                    />
                </PageHeaderMarkSlot>
            )}
            actions={enabled || (props.menuActions?.length ?? 0) > 0 ? (
                <View style={styles.actions}>
                    {enabled ? (
                        <PageHeaderStateSwitch
                            testID="settings.agents.detail.enabled"
                            label={t('settingsAgents.enabledTitle')}
                            value={enabled.value ?? undefined}
                            disabled={enabled.disabled || enabled.value === null}
                            onValueChange={enabled.onChange}
                            accessibilityHint={enabled.disabled
                                ? t('connectedServices.accountScopeMismatchDescription')
                                : t('settingsAgents.enabledSubtitle')}
                        />
                    ) : null}
                    {props.menuActions && props.menuActions.length > 0 ? (
                        <PageHeaderMenu actions={props.menuActions} triggerTestID="settings.agents.detail.menu" />
                    ) : null}
                </View>
            ) : undefined}
        />
    );
});

const stylesheet = StyleSheet.create(() => ({
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
}));

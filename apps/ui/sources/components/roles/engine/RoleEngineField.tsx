import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { RoleEngineV1 } from '@happier-dev/protocol';

import { useRoleEngineCatalog } from '@/components/roles/catalog/useRoleEnginePresentation';
import { AgentInputChipPickerPopover } from '@/components/sessions/agentInput/components/AgentInputChipPickerPopover';
import { buildSessionAgentPickerDetailContent } from '@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent';
import { buildSessionAgentPickerOptions } from '@/components/sessions/agentPicker/buildSessionAgentPickerOptions';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { useActiveServerAccountScope, useSettings } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { buildRolesRailPickerOption, type RolesRailPickerOptionParams } from '../rail/buildRolesRailPickerOption';
import { AgentInputSelectionPopover } from '@/components/sessions/agentInput/selection/AgentInputSelectionPopover';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';

/** The Agent config option a role's `engine.effort` is (the same id `admitAgentStartV1` stamps). */
const ROLE_EFFORT_CONFIG_OPTION_ID = 'reasoning_effort';

/**
 * A role's engine as a page field: the value ("Claude · opus-5.5") in the field box, opening the same
 * engine popover the composer uses (Agents in the rail, the chosen Agent's models beside it).
 * Nothing is asked of a machine until the popover opens on an Agent.
 */
export const RoleEngineField = React.memo(function RoleEngineField(props: Readonly<{
    serverId?: string | null;
    engine: RoleEngineV1 | undefined;
    label: string | null;
    leading?: React.ReactNode;
    disabled?: boolean;
    onChange: (engine: RoleEngineV1) => void;
    /** Engine-group consumers may also choose a Role through the incumbent rail. */
    roleSelection?: RolesRailPickerOptionParams;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const scope = useActiveServerAccountScope(props.serverId);
    const unavailable = props.serverId !== undefined && scope === null;
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const trigger = renderDropdownItemTriggerRightElement({
        detail: props.label ?? t('roles.rail.defaultEngine'),
        open,
        detailColor: theme.colors.text.primary,
        chevronColor: theme.colors.text.secondary,
        field: resolveFieldBoxColors(theme),
        placeholder: t('roles.rail.defaultEngine'),
        leading: props.leading,
    });
    return (
        <View ref={anchorRef} collapsable={false}>
            <HappierPressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={`${t('roles.settings.engineTitle')}: ${props.label ?? t('roles.rail.defaultEngine')}`}
                disabled={props.disabled || unavailable}
                onPress={() => { if (!unavailable) setOpen(true); }}
            >
                {trigger}
            </HappierPressable>
            {open && !unavailable ? (
                <RoleEnginePopover
                    capabilityServerId={scope?.serverId ?? ''}
                    anchorRef={anchorRef}
                    engine={props.engine}
                    onChange={props.onChange}
                    roleSelection={props.roleSelection}
                    onRequestClose={() => setOpen(false)}
                />
            ) : null}
        </View>
    );
});

/** Mounted only while open: the Agent catalog and model probes belong to the open popover. */
function RoleEnginePopover(props: Readonly<{
    capabilityServerId: string;
    anchorRef: React.RefObject<View | null>;
    engine: RoleEngineV1 | undefined;
    onChange: (engine: RoleEngineV1) => void;
    roleSelection?: RolesRailPickerOptionParams;
    onRequestClose: () => void;
}>) {
    const settings = useSettings();
    const { entries, ready, scope, snapshot } = useRoleEngineCatalog(props.capabilityServerId || undefined);
    const { capabilityServerId } = props;
    const { engine, onChange } = props;
    const options = React.useMemo(() => buildSessionAgentPickerOptions({
        entries,
        leadingOptions: props.roleSelection ? [buildRolesRailPickerOption(props.roleSelection)] : undefined,
        identityScope: { machineId: null, serverId: capabilityServerId || null, current: false },
        resolvePresentation: () => ({ disabled: false, muted: false }),
        resolveBehavior: ({ entry }) => ({
            detailTitle: entry.title,
            deferRenderDetailContent: true,
            deferredDetailContentCacheKey: `role-engine:${entry.backendTargetKey}`,
            closeOnSelectImmediate: false,
            onSelectImmediate: () => {
                if (engine?.agentTargetKey !== entry.backendTargetKey) {
                    onChange({ agentTargetKey: entry.backendTargetKey });
                }
            },
            renderDetailContent: () => buildSessionAgentPickerDetailContent({
                backendTarget: entry.backendTarget,
                agentCatalogEntry: entry.agentCatalogEntry,
                runtimeCarrierAgentId: entry.agentId,
                selectedMachineId: null,
                capabilityServerId,
                cwd: null,
                settings,
                selection: {
                    modelId: engine?.agentTargetKey === entry.backendTargetKey ? engine.modelId ?? '' : '',
                    sessionModeId: null,
                    // The role's effort is the Agent's `reasoning_effort` option, the one the picker
                    // offers beside the models; admission stamps it back the same way (`admitAgentStartV1`).
                    configOverrides: engine?.agentTargetKey === entry.backendTargetKey && engine.effort
                        ? { [ROLE_EFFORT_CONFIG_OPTION_ID]: engine.effort } : {},
                },
                onSelectionChange: (next) => {
                    const effort = next.configOverrides[ROLE_EFFORT_CONFIG_OPTION_ID];
                    onChange({
                        agentTargetKey: entry.backendTargetKey,
                        ...(next.modelId ? { modelId: next.modelId } : {}),
                        ...(effort ? { effort } : {}),
                    });
                },
            }),
        }),
    }), [capabilityServerId, engine, entries, onChange, props.roleSelection, settings]);

    if (!ready) {
        const unavailable = scope === null || snapshot?.catalog.status === 'unavailable' || snapshot?.catalog.status === 'partial';
        return <AgentInputSelectionPopover open anchorRef={props.anchorRef} onRequestClose={props.onRequestClose}>
            {() => <SurfaceStateCard testID="role-engine-catalog-state" size="line" kind={unavailable ? 'error' : 'loading'}
                title={t(unavailable ? 'common.unavailable' : 'common.loading')} />}
        </AgentInputSelectionPopover>;
    }
    return (
        <AgentInputChipPickerPopover
            open
            anchorRef={props.anchorRef}
            title=""
            options={options}
            selectedOptionId={engine?.agentTargetKey ?? null}
            onSelect={() => {}}
            onRequestClose={props.onRequestClose}
            detailContentOwnsScroll
            maxHeightCap={460}
        />
    );
}

import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { SessionMcpSelectionV1Schema, type SessionMcpSelectionV1 } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';

import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { useNewSessionMcpSelection } from '@/components/sessions/new/hooks/useNewSessionMcpSelection';

import type { SessionAuthoringMcpContext } from './sessionAuthoringFieldControls';

/**
 * The controlled MCP selection for an authoring value.
 *
 * The chip, its preview against the exact Machine and folder, and the
 * selection content are the incumbent New Session MCP owner's, so a workflow
 * default or step override edits exactly what New Session edits. This
 * component only adapts the controlled value to that owner's state contract
 * and hosts the chip's content popover, which the composer bar's overlay
 * controller would otherwise own.
 */

/** An omitted or explicit-automatic selection is previewed as the canonical default policy. */
const AUTOMATIC_MCP_SELECTION: SessionMcpSelectionV1 = SessionMcpSelectionV1Schema.parse({});

export function SessionAuthoringMcpSelectionField(props: Readonly<{
    agentId: string;
    context: SessionAuthoringMcpContext;
    value: SessionMcpSelectionV1 | null | undefined;
    onChange: (value: SessionMcpSelectionV1) => void;
    chipRenderContext: AgentInputExtraActionChipRenderContext;
    testID: string;
}>): React.ReactElement | null {
    const { onChange } = props;
    const router = useRouter();
    const selection = props.value ?? AUTOMATIC_MCP_SELECTION;
    const selectionRef = React.useRef(selection);
    selectionRef.current = selection;
    // The owner's contract is a state setter; a functional update reads the
    // controlled value rather than a private copy of it.
    const setSelection = React.useCallback<React.Dispatch<React.SetStateAction<SessionMcpSelectionV1>>>((next) => {
        onChange(typeof next === 'function' ? next(selectionRef.current) : next);
    }, [onChange]);
    const onOpenSettings = React.useCallback(() => {
        // `router.push` expects the public route; group segments are not valid on web.
        router.push('/settings/mcp' as never);
    }, [router]);

    const { mcpChip } = useNewSessionMcpSelection({
        selectedMachineId: props.context.machineId,
        selectedPath: props.context.directory,
        selectedMachineName: props.context.machineName,
        agentType: props.agentId,
        targetServerId: props.context.serverId,
        mcpSelection: selection,
        setMcpSelection: setSelection,
        onOpenSettings,
    });

    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
    const renderContext = React.useMemo<AgentInputExtraActionChipRenderContext>(() => ({
        ...props.chipRenderContext,
        chipAnchorRef: anchorRef,
        toggleCollapsedPopover: () => setOpen((current) => !current),
    }), [props.chipRenderContext]);

    if (mcpChip === null) return null;
    const popover = mcpChip.collapsedContentPopover;
    return (
        <View testID={props.testID} style={{ alignSelf: 'flex-start' }}>
            {mcpChip.render(renderContext)}
            {popover === undefined ? null : (
                <AgentInputContentPopover
                    open={open}
                    anchorRef={anchorRef}
                    content={popover.renderContent}
                    onRequestClose={() => setOpen(false)}
                    {...(popover.maxHeightCap === undefined ? {} : { maxHeightCap: popover.maxHeightCap })}
                    {...(popover.maxWidthCap === undefined ? {} : { maxWidthCap: popover.maxWidthCap })}
                    {...(popover.scrollEnabled === undefined ? {} : { scrollEnabled: popover.scrollEnabled })}
                />
            )}
        </View>
    );
}

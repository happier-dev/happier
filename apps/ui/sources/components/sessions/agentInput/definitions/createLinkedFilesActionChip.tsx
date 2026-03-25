import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputPopoverContent } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import { MachinePathBrowserView } from '@/components/ui/pathBrowser/MachinePathBrowserModal';
import { SessionRepositoryTreeBrowserView } from '@/components/sessions/files/views/SessionRepositoryTreeBrowserView';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';

const LINK_FILE_ICON: React.ComponentProps<typeof Ionicons>['name'] = 'at-outline';

function createBaseLinkFileChip(params: Readonly<{
    key: string;
    testID: string;
    disabled: boolean;
    popoverContent: AgentInputPopoverContent;
    maxHeightCap?: number;
    maxWidthCap?: number;
}>): AgentInputExtraActionChip {
    const label = t('common.linkFile');
    return {
        key: params.key,
        controlId: 'linkedFiles',
        labelPolicy: 'auto-hide',
        collapsedContentPopover: {
            title: label,
            label,
            icon: (tint: string) =>
                normalizeNodeForView(<Ionicons name={LINK_FILE_ICON} size={16} color={tint} />),
            renderContent: params.popoverContent,
            maxHeightCap: params.maxHeightCap,
            maxWidthCap: params.maxWidthCap,
            scrollEnabled: false,
        },
        render: ({ chipStyle, iconColor, showLabel, textStyle, countTextStyle, chipAnchorRef, toggleCollapsedPopover }) => (
            <Pressable
                ref={chipAnchorRef}
                testID={params.testID}
                onPress={() => {
                    if (params.disabled) return;
                    toggleCollapsedPopover?.(params.key);
                }}
                disabled={params.disabled}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={({ pressed }) => chipStyle(Boolean(pressed))}
            >
                {normalizeNodeForView(<Ionicons name={LINK_FILE_ICON} size={16} color={iconColor} />)}
                {showLabel ? (
                    <AgentInputChipLabel
                        label={label}
                        textStyle={textStyle}
                        countTextStyle={countTextStyle}
                    />
                ) : null}
            </Pressable>
        ),
    };
}

export function createLinkedFilesActionChip(params: Readonly<{
    sessionId: string;
    disabled: boolean;
    onPickPath: (path: string) => void;
}>): AgentInputExtraActionChip {
    return createBaseLinkFileChip({
        key: 'project-file-link',
        testID: 'agent-input-link-file',
        disabled: params.disabled,
        maxHeightCap: 520,
        maxWidthCap: 560,
        popoverContent: ({ requestClose }) => (
            <SessionRepositoryTreeBrowserView
                sessionId={params.sessionId}
                density="panel"
                onRequestClose={requestClose}
                onOpenFile={(fullPath) => {
                    params.onPickPath(fullPath);
                    requestClose();
                }}
                onOpenFilePinned={(fullPath) => {
                    params.onPickPath(fullPath);
                    requestClose();
                }}
            />
        ),
    });
}

export function createNewSessionLinkedFilesActionChip(params: Readonly<{
    machineId: string | null;
    serverId?: string | null;
    rootDirectoryPath: string | null;
    disabled: boolean;
    onPickPath: (path: string) => void;
}>): AgentInputExtraActionChip {
    const disabled = params.disabled || !params.machineId || !params.rootDirectoryPath;
    const machineId = params.machineId ?? '';
    const rootDirectoryPath = params.rootDirectoryPath ?? '';

    return createBaseLinkFileChip({
        key: 'new-session-link-file',
        testID: 'new-session-link-file-chip',
        disabled,
        maxHeightCap: 520,
        maxWidthCap: 560,
        popoverContent: ({ requestClose, maxHeight }) => (
            <MachinePathBrowserView
                machineId={machineId}
                serverId={params.serverId}
                rootDirectoryPath={rootDirectoryPath}
                includeFiles
                selectionMode="file"
                variant="popover"
                interaction="immediate"
                maxHeight={maxHeight}
                onPickPath={(path) => {
                    params.onPickPath(path);
                    requestClose();
                }}
                onRequestClose={requestClose}
            />
        ),
    });
}

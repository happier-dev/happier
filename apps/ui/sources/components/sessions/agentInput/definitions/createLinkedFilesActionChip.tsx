import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputPopoverContent } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';
import { LinkFilePickerPopoverContent } from '@/components/sessions/linkedFiles/projectPicker/LinkFilePickerPopoverContent';

const LINK_FILE_ICON: React.ComponentProps<typeof Ionicons>['name'] = 'at';

function normalizeAbsoluteDirectoryForPrefix(raw: string): { normalized: string; prefix: string; isWindows: boolean } | null {
    const value = String(raw ?? '').trim();
    if (!value) return null;

    const isWindows = /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\');
    if (isWindows) {
        const trimmed = value.replace(/[\\/]+$/g, '');
        const driveRootMatch = /^([A-Za-z]:)$/.exec(trimmed);
        const normalized = driveRootMatch ? `${driveRootMatch[1]}\\` : trimmed;
        const prefix = normalized.endsWith('\\') || normalized.endsWith('/') ? normalized : `${normalized}\\`;
        return { normalized, prefix, isWindows: true };
    }

    if (value === '/') {
        return { normalized: '/', prefix: '/', isWindows: false };
    }
    const normalized = value.replace(/\/+$/g, '');
    const prefix = normalized.endsWith('/') ? normalized : `${normalized}/`;
    return { normalized, prefix, isWindows: false };
}

function resolveRelativePathUnderDirectory(rootDirectoryPath: string, absolutePath: string): string {
    const root = normalizeAbsoluteDirectoryForPrefix(rootDirectoryPath);
    if (!root) return absolutePath;

    const candidate = String(absolutePath ?? '').trim();
    if (!candidate) return candidate;
    const candidateComparable = root.isWindows ? candidate.toLowerCase() : candidate;
    const prefixComparable = root.isWindows ? root.prefix.toLowerCase() : root.prefix;
    if (!candidateComparable.startsWith(prefixComparable)) return candidate;
    return candidate.slice(root.prefix.length).replace(/^[\\/]+/g, '');
}

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
            // The picker wraps its virtualized browser with an explicit height, so the browser owns scrolling.
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
        popoverContent: ({ requestClose, maxHeight }) => (
            <LinkFilePickerPopoverContent
                sessionId={params.sessionId}
                maxHeight={maxHeight}
                onPickPath={params.onPickPath}
                onRequestClose={requestClose}
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
            <LinkFilePickerPopoverContent
                machineId={machineId}
                serverId={params.serverId}
                rootDirectoryPath={rootDirectoryPath}
                maxHeight={maxHeight}
                onPickPath={(path) => {
                    // Align with session repo-browser behavior: link files relative to the selected root.
                    params.onPickPath(resolveRelativePathUnderDirectory(rootDirectoryPath, path));
                }}
                onRequestClose={requestClose}
            />
        ),
    });
}

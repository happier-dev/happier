import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { t } from '@/text';
import { ICON_TERMINAL, ICON_EXIT } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { extractShellCommand, stripShellCommandPreludeForDisplay } from '../../normalization/parse/shellCommand';
import { extractHappierToolsShellBridgeCommand } from '../../normalization/parse/happierToolsShellBridge';
import { getHappierToolsShellBridgeDisplay } from '../../normalization/parse/happierToolsShellBridgeDisplay';
import { BashInputV2Schema, BashResultV2Schema, ExitPlanModeInputV2Schema } from '@happier-dev/protocol';

export const coreTerminalTools = {
    'Bash': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const shellBridge = extractHappierToolsShellBridgeCommand(opts.tool.input);
            if (shellBridge) {
                return t('tools.desc.terminalCmd', { cmd: getHappierToolsShellBridgeDisplay(shellBridge).titleCommand });
            }

            const cmdRaw = extractShellCommand(opts.tool.input);
            const cmd = typeof cmdRaw === 'string' ? stripShellCommandPreludeForDisplay(cmdRaw) : cmdRaw;
            if (typeof cmd === 'string') {
                const firstWord = cmd.trim().split(/\s+/)[0];
                if (firstWord) return t('tools.desc.terminalCmd', { cmd: firstWord });
            }

            const rawDescription = typeof opts.tool.description === 'string' ? opts.tool.description.trim() : '';
            // Some providers (and permission-wrapped ACP tools) emit a generic marker like "execute"
            // rather than a helpful "Run <cmd>" title. Prefer deriving a stable title from the input.
            if (rawDescription && rawDescription.toLowerCase() !== 'execute') {
                return rawDescription;
            }

            return t('tools.names.terminal');
        },
        icon: ICON_TERMINAL,
        minimal: true,
        hideDefaultError: true,
        isMutable: true,
        input: BashInputV2Schema,
        result: BashResultV2Schema,
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const shellBridge = extractHappierToolsShellBridgeCommand(opts.tool.input);
            if (shellBridge) {
                return getHappierToolsShellBridgeDisplay(shellBridge).description;
            }

            const cmdRaw = extractShellCommand(opts.tool.input);
            const cmd = typeof cmdRaw === 'string' ? stripShellCommandPreludeForDisplay(cmdRaw) : cmdRaw;
            if (typeof cmd === 'string' && cmd.length > 0) {
                // Extract just the command name for common commands
                const firstWord = cmd.split(' ')[0];
                if (['cd', 'ls', 'pwd', 'mkdir', 'rm', 'cp', 'mv', 'npm', 'yarn', 'git'].includes(firstWord)) {
                    return t('tools.desc.terminalCmd', { cmd: firstWord });
                }
                // For other commands, show truncated version
                const truncated = cmd.length > 20 ? cmd.substring(0, 20) + '...' : cmd;
                return t('tools.desc.terminalCmd', { cmd: truncated });
            }
            return t('tools.names.terminal');
        },
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const shellBridge = extractHappierToolsShellBridgeCommand(opts.tool.input);
            if (shellBridge) return getHappierToolsShellBridgeDisplay(shellBridge).subtitle;

            const cmdRaw = extractShellCommand(opts.tool.input);
            const cmd = typeof cmdRaw === 'string' ? stripShellCommandPreludeForDisplay(cmdRaw) : cmdRaw;
            if (typeof cmd === 'string' && cmd.length > 0) return cmd;
            return null;
        }
    },
    'ExitPlanMode': {
        title: t('tools.names.planProposal'),
        icon: ICON_EXIT,
        input: ExitPlanModeInputV2Schema,
    },
    'exit_plan_mode': {
        title: t('tools.names.planProposal'),
        icon: ICON_EXIT,
        input: ExitPlanModeInputV2Schema,
    },
} satisfies Record<string, KnownToolDefinition>;

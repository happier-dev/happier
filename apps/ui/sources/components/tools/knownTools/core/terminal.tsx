import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import { t } from '@/text';
import { ICON_TERMINAL, ICON_EXIT } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { extractShellCommand } from '../../utils/shellCommand';
import { BashInputV2Schema, BashResultV2Schema, ExitPlanModeInputV2Schema } from '@happier-dev/protocol';

export const coreTerminalTools = {
    'Bash': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.description) {
                return opts.tool.description;
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
            const cmd = extractShellCommand(opts.tool.input);
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
            const cmd = extractShellCommand(opts.tool.input);
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

import { createKnownToolTitle } from '../toolTitles';
import { extractShellCommand, stripShellCommandPreludeForDisplay } from '@happier-dev/protocol/activity/shellCommand';
import type { Metadata } from '@happier-dev/session-core/state';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { resolvePath } from '@/utils/path/pathUtils';
import * as z from 'zod/mini';
import { t } from '@/text';
import { ICON_TERMINAL } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { extractHappierToolsShellBridgeCommand } from "@happier-dev/session-core/tools";
import { getHappierToolsShellBridgeDisplay } from "@happier-dev/session-core/tools";

export const providerShellTools = {
    'CodexBash': {
        title: createKnownToolTitle("CodexBash"),
        icon: ICON_TERMINAL,
        minimal: true,
        hideDefaultError: true,
        isMutable: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            command: z.array(z.string()).check(z.describe('The command array to execute')),
            cwd: z.optional(z.string()).check(z.describe('Current working directory')),
            parsed_cmd: z.optional(z.array(z.looseObject({
                type: z.string().check(z.describe('Type of parsed command (read, write, bash, etc.)')),
                cmd: z.optional(z.string()).check(z.describe('The command string')),
                name: z.optional(z.string()).check(z.describe('File name or resource name'))
            }))).check(z.describe('Parsed command information'))
        }))),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // For single read commands, show the actual command
            if (opts.tool.input?.parsed_cmd &&
                Array.isArray(opts.tool.input.parsed_cmd) &&
                opts.tool.input.parsed_cmd.length === 1 &&
                opts.tool.input.parsed_cmd[0].type === 'read') {
                const parsedCmd = opts.tool.input.parsed_cmd[0];
                if (parsedCmd.cmd) {
                    // Show the command but truncate if too long
                    const cmd = parsedCmd.cmd;
                    return cmd.length > 50 ? cmd.substring(0, 50) + '...' : cmd;
                }
            }
            // Show the actual command being executed for other cases
            if (opts.tool.input?.parsed_cmd && Array.isArray(opts.tool.input.parsed_cmd) && opts.tool.input.parsed_cmd.length > 0) {
                const parsedCmd = opts.tool.input.parsed_cmd[0];
                if (parsedCmd.cmd) {
                    return parsedCmd.cmd;
                }
            }
            if (opts.tool.input?.command && Array.isArray(opts.tool.input.command)) {
                let cmdArray = opts.tool.input.command;
                // Remove shell wrapper prefix if present (bash/zsh with -lc flag)
                if (cmdArray.length >= 3 && (cmdArray[0] === 'bash' || cmdArray[0] === '/bin/bash' || cmdArray[0] === 'zsh' || cmdArray[0] === '/bin/zsh') && cmdArray[1] === '-lc') {
                    // The actual command is in the third element
                    return cmdArray[2];
                }
                return cmdArray.join(' ');
            }
            return null;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Provide a description based on the parsed command type
            if (opts.tool.input?.parsed_cmd &&
                Array.isArray(opts.tool.input.parsed_cmd) &&
                opts.tool.input.parsed_cmd.length === 1) {
                const parsedCmd = opts.tool.input.parsed_cmd[0];
                if (parsedCmd.type === 'read' && parsedCmd.name) {
                    // For single read commands, show "Reading" as simple description
                    // The file path is already in the title
                    const path = resolvePath(parsedCmd.name, opts.metadata);
                    const basename = path.split('/').pop() || path;
                    return t('tools.desc.readingFile', { file: basename });
                } else if (parsedCmd.type === 'write' && parsedCmd.name) {
                    const path = resolvePath(parsedCmd.name, opts.metadata);
                    const basename = path.split('/').pop() || path;
                    return t('tools.desc.writingFile', { file: basename });
                }
            }
            return t('tools.names.terminal');
        }
    },
    'GeminiBash': {
        title: createKnownToolTitle("GeminiBash"),
        icon: ICON_TERMINAL,
        minimal: true,
        hideDefaultError: true,
        isMutable: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            command: z.array(z.string()).check(z.describe('The command array to execute')),
            cwd: z.optional(z.string()).check(z.describe('Current working directory'))
        }))),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.input?.command && Array.isArray(opts.tool.input.command)) {
                let cmdArray = opts.tool.input.command;
                // Remove shell wrapper prefix if present (bash/zsh with -lc flag)
                if (cmdArray.length >= 3 && (cmdArray[0] === 'bash' || cmdArray[0] === '/bin/bash' || cmdArray[0] === 'zsh' || cmdArray[0] === '/bin/zsh') && cmdArray[1] === '-lc') {
                    return cmdArray[2];
                }
                return cmdArray.join(' ');
            }
            return null;
        }
    },
    'shell': {
        title: createKnownToolTitle("shell"),
        icon: ICON_TERMINAL,
        minimal: true,
        isMutable: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({})))
    },
    'execute': {
        title: createKnownToolTitle("execute"),
        icon: ICON_TERMINAL,
        isMutable: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({}))),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const shellBridge = extractHappierToolsShellBridgeCommand(opts.tool.input);
            if (shellBridge) return getHappierToolsShellBridgeDisplay(shellBridge).subtitle;

            const cmd = extractShellCommand(opts.tool.input);
            if (cmd) return stripShellCommandPreludeForDisplay(cmd);
            return null;
        }
    },
} satisfies Record<string, KnownToolDefinition>;

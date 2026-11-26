import type { Metadata } from '@happier-dev/session-core/state';
import type { ToolCall, Message } from "@happier-dev/session-core/messages";
import type { ReactNode } from 'react';
import type * as z from 'zod/mini';

export type KnownToolDefinition = {
    title?: string | ((opts: { metadata: Metadata | null, tool: ToolCall }) => string);
    icon: (size: number, color: string, opts?: { metadata: Metadata | null, tool: ToolCall }) => ReactNode;
    noStatus?: boolean;
    hideDefaultError?: boolean;
    isMutable?: boolean;
    input?: z.core.$ZodObject;
    result?: z.core.$ZodObject;
    minimal?: boolean | ((opts: { metadata: Metadata | null, tool: ToolCall, messages?: Message[] }) => boolean);
    extractDescription?: (opts: { metadata: Metadata | null, tool: ToolCall }) => string;
    /** `messages`: the call's child transcript messages, when the shell holds them (a Script's inner calls). */
    extractSubtitle?: (opts: { metadata: Metadata | null, tool: ToolCall, messages?: readonly Message[] }) => string | null;
    extractStatus?: (opts: { metadata: Metadata | null, tool: ToolCall }) => string | null;
};

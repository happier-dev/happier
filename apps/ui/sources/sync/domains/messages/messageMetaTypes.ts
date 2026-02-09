import { z } from 'zod';
import { PERMISSION_MODES } from '@/constants/PermissionModes';

const DANGEROUS_META_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeMessageMetaObject(meta: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta)) {
        if (DANGEROUS_META_KEYS.has(key)) continue;
        out[key] = value;
    }
    return out;
}

// Shared message metadata schema
export const MessageMetaSchema = z.object({
    sentFrom: z.string().optional(), // Source identifier (forward-compatible)
    /**
     * High-level origin of the message, used by agents to avoid treating
     * self-sent client traffic as a "new prompt" event.
     *
     * Forward-compatible: unknown strings are allowed.
     */
    source: z.union([z.enum(['ui', 'cli']), z.string()]).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(), // Permission mode for this message
    model: z.string().nullable().optional(), // Model name for this message (null = reset)
    fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
    customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
    appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
    allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
    disallowedTools: z.array(z.string()).nullable().optional(), // Disallowed tools for this message (null = reset)
    displayText: z.string().optional() // Optional text to display in UI instead of actual message text
}).passthrough().transform((meta) => sanitizeMessageMetaObject(meta as Record<string, unknown>));

export type MessageMeta = z.infer<typeof MessageMetaSchema>;

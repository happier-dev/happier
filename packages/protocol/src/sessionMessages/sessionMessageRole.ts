import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const SESSION_MESSAGE_ROLES = ['user', 'agent', 'event', 'unknown'] as const;

export const SessionMessageRoleSchema = lazySchema(() => z.enum(SESSION_MESSAGE_ROLES));

export type SessionMessageRole = z.infer<typeof SessionMessageRoleSchema>;

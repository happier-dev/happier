import { z } from 'zod';

export const SESSION_MESSAGE_ROLES = ['user', 'agent', 'event', 'unknown'] as const;

export const SessionMessageRoleSchema = z.enum(SESSION_MESSAGE_ROLES);

export type SessionMessageRole = z.infer<typeof SessionMessageRoleSchema>;

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const WINDOWS_REMOTE_SESSION_LAUNCH_MODES = ['hidden', 'windows_terminal', 'console'] as const;
export type WindowsRemoteSessionLaunchMode = (typeof WINDOWS_REMOTE_SESSION_LAUNCH_MODES)[number];

export const WindowsRemoteSessionLaunchModeSchema = lazyZodSchema(() => z.enum(WINDOWS_REMOTE_SESSION_LAUNCH_MODES));

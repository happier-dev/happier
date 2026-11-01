import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const WINDOWS_REMOTE_SESSION_LAUNCH_MODES = ['hidden', 'windows_terminal', 'console'] as const;
export type WindowsRemoteSessionLaunchMode = (typeof WINDOWS_REMOTE_SESSION_LAUNCH_MODES)[number];

export const WindowsRemoteSessionLaunchModeSchema = lazySchema(() => z.enum(WINDOWS_REMOTE_SESSION_LAUNCH_MODES));

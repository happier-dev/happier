import { z } from 'zod';

export const WINDOWS_REMOTE_SESSION_LAUNCH_MODES = ['hidden', 'windows_terminal', 'console'] as const;
export type WindowsRemoteSessionLaunchMode = (typeof WINDOWS_REMOTE_SESSION_LAUNCH_MODES)[number];

export const WindowsRemoteSessionLaunchModeSchema = z.enum(WINDOWS_REMOTE_SESSION_LAUNCH_MODES);

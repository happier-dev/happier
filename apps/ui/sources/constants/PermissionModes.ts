import { SESSION_PERMISSION_MODES } from '@happier-dev/protocol/sessions/metadata/permission-modes';

export const PERMISSION_MODES = SESSION_PERMISSION_MODES;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

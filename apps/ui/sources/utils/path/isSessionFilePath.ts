import { isSafeWorkspaceRelativePath } from './isSafeWorkspaceRelativePath';
import { isAbsoluteLocalPath } from './resolvePathRelativeToRoot';

/** File previews accept machine paths; filesystem authorization remains with the daemon. */
export function isSessionFilePath(value: string): boolean {
    if (!value || /[\u0000-\u001f\u007f]/.test(value) || value.includes('\\')) return false;
    return isAbsoluteLocalPath(value) || isSafeWorkspaceRelativePath(value);
}

import {
  SCM_OPERATION_ERROR_CODES,
  type ScmOperationErrorCode,
} from '@happier-dev/plugin-sdk/scm';
import {
  mapSaplingScmErrorCode } from '@happier-dev/plugin-sdk/scm/backend';

function isSaplingExecutableMissing(stderr: string): boolean {
    const value = String(stderr ?? '');
    return /\bspawn\s+sl\s+ENOENT\b/i.test(value)
        || /\bsl(?:\.exe)?:\s+(?:command\s+)?not found\b/i.test(value)
        || /\bno such file or directory\b.*\bsl(?:\.exe)?\b/i.test(value);
}

export function mapSaplingErrorCode(stderr: string): ScmOperationErrorCode {
    if (isSaplingExecutableMissing(stderr)) {
        return SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE;
    }
    return mapSaplingScmErrorCode(stderr);
}

import { mapSaplingScmErrorCode, type ScmOperationErrorCode } from '@happier-dev/protocol';

export function mapSaplingErrorCode(stderr: string): ScmOperationErrorCode {
    return mapSaplingScmErrorCode(stderr);
}

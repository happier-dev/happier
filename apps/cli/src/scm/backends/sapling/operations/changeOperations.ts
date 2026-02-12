import type { ScmChangeApplyResponse } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

export function saplingChangeInclude(): ScmChangeApplyResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: 'Sapling backend does not support include operations in this version',
    };
}

export function saplingChangeExclude(): ScmChangeApplyResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: 'Sapling backend does not support exclude operations in this version',
    };
}

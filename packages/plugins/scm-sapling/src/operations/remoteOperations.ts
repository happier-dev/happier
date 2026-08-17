import type {
  ScmRemoteRequest,
  ScmRemoteResponse,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import { normalizeScmRemoteRequest } from '@happier-dev/plugin-sdk/scm';
import type { BackendRuntimeContext as ScmBackendContext } from '@happier-dev/plugin-sdk/scm/backend';

function unsupportedSaplingRemoteMutation(kind: 'fetch' | 'pull' | 'push'): ScmRemoteResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: `Sapling ${kind} is not supported by this backend.`,
    };
}

export async function saplingRemoteFetch(input: {
    context: ScmBackendContext;
    request: ScmRemoteRequest;
}): Promise<ScmRemoteResponse> {
    const { request } = input;
    const normalized = normalizeScmRemoteRequest(request);
    if (!normalized.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: normalized.error,
        };
    }
    return unsupportedSaplingRemoteMutation('fetch');
}

export async function saplingRemotePull(input: {
    context: ScmBackendContext;
    request: ScmRemoteRequest;
}): Promise<ScmRemoteResponse> {
    const { request } = input;
    const normalized = normalizeScmRemoteRequest(request);
    if (!normalized.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: normalized.error,
        };
    }
    return unsupportedSaplingRemoteMutation('pull');
}

export async function saplingRemotePush(input: {
    context: ScmBackendContext;
    request: ScmRemoteRequest;
}): Promise<ScmRemoteResponse> {
    const { request } = input;
    const normalized = normalizeScmRemoteRequest(request);
    if (!normalized.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: normalized.error,
        };
    }
    return unsupportedSaplingRemoteMutation('push');
}

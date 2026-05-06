import { bitbucketScmHostingBasicAuthMaterializer } from './providers/bitbucket/bitbucketScmHostingBasicAuthMaterializer';
import type {
  ScmHostingBasicAuthMaterializationRequest,
  ScmHostingBasicAuthMaterializationResult,
  ScmHostingBasicAuthMaterializer,
} from './types';

const SCM_HOSTING_BASIC_AUTH_MATERIALIZERS: readonly ScmHostingBasicAuthMaterializer[] = Object.freeze([
  bitbucketScmHostingBasicAuthMaterializer,
]);

export function resolveScmHostingBasicAuthMaterialization(
  request: ScmHostingBasicAuthMaterializationRequest,
): ScmHostingBasicAuthMaterializationResult {
  for (const materializer of SCM_HOSTING_BASIC_AUTH_MATERIALIZERS) {
    const result = materializer.materialize(request);
    if (result.kind === 'available' || result.reason !== 'unsupported_provider') {
      return result;
    }
  }
  return { kind: 'missing', reason: 'unsupported_provider' };
}

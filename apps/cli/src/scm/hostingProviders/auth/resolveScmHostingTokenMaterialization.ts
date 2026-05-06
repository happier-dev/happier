import { githubScmHostingTokenMaterializer } from './providers/github/githubScmHostingTokenMaterializer';
import type {
  ScmHostingTokenMaterializationRequest,
  ScmHostingTokenMaterializationResult,
  ScmHostingTokenMaterializer,
} from './types';

const SCM_HOSTING_TOKEN_MATERIALIZERS: readonly ScmHostingTokenMaterializer[] = Object.freeze([
  githubScmHostingTokenMaterializer,
]);

export function resolveScmHostingTokenMaterialization(
  request: ScmHostingTokenMaterializationRequest,
): ScmHostingTokenMaterializationResult {
  for (const materializer of SCM_HOSTING_TOKEN_MATERIALIZERS) {
    const result = materializer.materialize(request);
    if (result.kind === 'available' || result.reason !== 'unsupported_provider') {
      return result;
    }
  }
  return { kind: 'missing', reason: 'unsupported_provider' };
}

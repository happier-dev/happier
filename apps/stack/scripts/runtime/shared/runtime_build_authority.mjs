import { getRepoDir, getStacksStorageRoot, resolveStackBaseDir } from '../../utils/paths/paths.mjs';
import { isRepoStackIdentityName, resolveRepoStackIdentity } from '../../utils/stack/repo_stack_identity.mjs';
import { assertCanonicalManagedStackName } from '../../utils/stack/names.mjs';

function normalizeStackName(value, fallback = '') {
  return String(value ?? '').trim() || fallback;
}

export function resolveRuntimeBuildAuthority({
  rootDir,
  consumerStackName,
  env = process.env,
  createRepoIdentityIfMissing = true,
  resolveRepoStackIdentityImpl = resolveRepoStackIdentity,
} = {}) {
  const normalizedConsumerStackName = normalizeStackName(
    consumerStackName,
    normalizeStackName(env.HAPPIER_STACK_STACK, 'main'),
  );
  assertCanonicalManagedStackName(normalizedConsumerStackName, 'consumer');
  const { baseDir: consumerStackBaseDir } = resolveStackBaseDir(normalizedConsumerStackName, env);
  const explicitProducerStackName = normalizeStackName(env.HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK);

  if (explicitProducerStackName) {
    assertCanonicalManagedStackName(explicitProducerStackName, 'producer');
    const { baseDir: producerStackBaseDir } = resolveStackBaseDir(explicitProducerStackName, env);
    return {
      consumerStackName: normalizedConsumerStackName,
      consumerStackBaseDir,
      producerStackName: explicitProducerStackName,
      producerStackBaseDir,
      explicit: true,
    };
  }

  // A repository's own Stack is its build authority. Selecting it by name must
  // not make it a consumer of whichever checkout an inherited
  // HAPPIER_STACK_REPO_DIR names: consumers adopt their producer's registry.
  const repoDir = getRepoDir(rootDir, env);
  if (isRepoStackIdentityName(normalizedConsumerStackName)) {
    return {
      consumerStackName: normalizedConsumerStackName,
      consumerStackBaseDir,
      producerStackName: normalizedConsumerStackName,
      producerStackBaseDir: consumerStackBaseDir,
      repoDir,
      explicit: false,
    };
  }

  const identity = resolveRepoStackIdentityImpl({
    repoRoot: repoDir,
    stacksStorageRoot: getStacksStorageRoot(env),
    createIfMissing: createRepoIdentityIfMissing,
  });
  assertCanonicalManagedStackName(identity.stackName, 'producer');
  return {
    consumerStackName: normalizedConsumerStackName,
    consumerStackBaseDir,
    producerStackName: identity.stackName,
    producerStackBaseDir: identity.stackBaseDir,
    repoDir,
    explicit: false,
  };
}

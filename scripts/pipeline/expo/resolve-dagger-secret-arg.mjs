// @ts-check

/**
 * Dagger CLI secret arguments accept special encodings like `env://NAME` to read a secret
 * value from the local process environment without putting it on the CLI argv.
 *
 * @param {string} envVarName
 */
export function resolveDaggerSecretArg(envVarName) {
  const name = String(envVarName ?? '').trim();
  if (!name) {
    throw new Error('resolveDaggerSecretArg requires a non-empty env var name.');
  }
  if (!/^[A-Z0-9_]+$/.test(name)) {
    throw new Error(`resolveDaggerSecretArg expects an env var like EXPO_TOKEN (got: ${JSON.stringify(name)}).`);
  }
  return `env://${name}`;
}

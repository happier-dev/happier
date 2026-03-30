export function buildMissingJavaScriptRuntimeMessage(targetLabel: string): string {
  return (
    `No JavaScript runtime available to execute ${targetLabel}. ` +
    'On Bun-hosted/binary installs, managed JavaScript runtime bootstrap is required. ' +
    'Set HAPPIER_JS_RUNTIME_PATH, HAPPIER_MANAGED_NODE_BIN, or HAPPIER_NODE_PATH, ' +
    'or ensure the managed JavaScript runtime is available.'
  );
}

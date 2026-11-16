export const CLI_RUNTIME_SIDECAR_ENTRIES = Object.freeze([
  Object.freeze(['childProcessOptions.cjs']),
  Object.freeze(['claude_version_utils.cjs']),
  Object.freeze(['claude_local_launcher.cjs']),
  Object.freeze(['claude_remote_launcher.cjs']),
  Object.freeze(['session_hook_forwarder.cjs']),
  Object.freeze(['permission_hook_forwarder.cjs']),
  Object.freeze(['ripgrep_launcher.cjs']),
  Object.freeze(['ripgrep_runtime_paths.cjs']),
  Object.freeze(['statusline_forwarder.cjs']),
  Object.freeze(['terminal_launch_spec_runner.cjs']),
  Object.freeze(['native_process_exit.cjs']),
  Object.freeze(['process_tree.cjs']),
  Object.freeze(['node_pty_relay.cjs']),
  Object.freeze(['runtime']),
  Object.freeze(['shims']),
]);

// Runtime acquisition and source capture share these file-URL entrypoints;
// esbuild's emitted import graph cannot discover them.
export const CLI_OPTIONAL_NODE_RUNTIME_ENTRYPOINTS = Object.freeze({
  'happier-memory-runtime': 'node_modules/@huggingface/transformers/dist/transformers.node.mjs',
  'happier-voice-runtime': 'node_modules/sherpa-onnx-node/sherpa-onnx.js',
});

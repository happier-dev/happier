// Expo web bundling (Metro) cannot currently transform onnxruntime-web's bundle entry
// (it contains non-literal dynamic imports). This stub allows the app to bundle on web
// while keeping native/desktop usage unaffected.
//
// IMPORTANT: Any attempt to actually use the ONNX runtime on web should be implemented
// via a web-compatible backend; this module intentionally throws when sessions are created.

export const env: {
  wasm?: { wasmPaths?: string; proxy?: boolean };
  webgpu?: { powerPreference?: string };
} = {
  wasm: {},
  webgpu: {},
};

export class Tensor {}

export class InferenceSession {
  static async create(): Promise<never> {
    throw new Error('onnxruntime-web is not available in this web bundle');
  }
}

export default {
  env,
  Tensor,
  InferenceSession,
};


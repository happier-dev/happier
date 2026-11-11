import { xaiDiagnostic as diagnostic } from './failures.js';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { XaiCredential } from './credential.js';
import { readGrokNativeCredential } from './nativeCredentials.js';
import { createXaiPortableConnectedAccountRuntime, saveCredential } from './portableRuntime.js';
export { XAI_CREDENTIAL_KEY, XAI_DEVICE_SCOPES } from './portableRuntime.js';

/** Daemon composition adds Machine-local import to the app-runnable modes. */
export function createXaiConnectedAccountRuntime(): ConnectedAccountRuntime {
  const portable = createXaiPortableConnectedAccountRuntime();
  return {
    ...portable,
    authentication: { modes: {
      ...portable.authentication.modes,
      'native-import': { kind: 'manual', async complete(input, context, options) {
        if (input.fields.source !== 'native') return { status: 'rejected', diagnostic: diagnostic('xai_native_source_required') };
        const signal = options?.signal ?? context.signal;
        let credential: XaiCredential;
        try {
          credential = await readGrokNativeCredential({ signal });
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
            return { status: 'unavailable', diagnostic: diagnostic('xai_native_file_unavailable') };
          }
          return { status: 'rejected', diagnostic: diagnostic('xai_native_schema_unsupported') };
        }
        return saveCredential(credential, context);
      } },
    } },
  };
}
export const xaiConnectedAccountRuntime = createXaiConnectedAccountRuntime();

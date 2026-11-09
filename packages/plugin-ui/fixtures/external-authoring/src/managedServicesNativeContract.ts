import type { ManagedServiceResponse } from '@happier-dev/plugin-sdk/managed-services';

// Exercise the public byte reader under React Native without the DOM library.
export async function readManagedServiceChunk(response: ManagedServiceResponse) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  try {
    const chunk = await reader.read();
    if (chunk.done) return null;
    const bytes: Uint8Array = chunk.value;
    await reader.cancel();
    return bytes;
  } finally {
    reader.releaseLock();
  }
}

import axios from 'axios';

export type PostTerminalAuthRequestCompatibleResponse =
  | { state: 'requested'; expiresAt?: number }
  | { state: 'authorized' }
  | { state: 'authorized'; token: string; response: string };

export async function postTerminalAuthRequestCompatible(params: Readonly<{
  serverUrl: string;
  publicKey: string;
  supportsV2?: boolean;
  supportsTokenOnly?: boolean;
  claimSecretHash?: string;
  timeoutMs?: number;
}>): Promise<PostTerminalAuthRequestCompatibleResponse> {
  const url = `${params.serverUrl}/v1/auth/request`;
  const config = params.timeoutMs ? { timeout: params.timeoutMs } : undefined;
  try {
    const response = await axios.post<PostTerminalAuthRequestCompatibleResponse>(url, {
      publicKey: params.publicKey,
      ...(typeof params.supportsV2 === 'boolean' ? { supportsV2: params.supportsV2 } : {}),
      ...(typeof params.supportsTokenOnly === 'boolean' ? { supportsTokenOnly: params.supportsTokenOnly } : {}),
      ...(typeof params.claimSecretHash === 'string' ? { claimSecretHash: params.claimSecretHash } : {}),
    }, config);
    return response.data;
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status !== 400 && status !== 422) throw error;
    // Released servers with strict request schemas accept only the original public key.
    const response = await axios.post<PostTerminalAuthRequestCompatibleResponse>(url, {
      publicKey: params.publicKey,
    }, config);
    return response.data;
  }
}

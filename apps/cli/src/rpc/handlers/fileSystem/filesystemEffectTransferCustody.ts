import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

/** Native file transfers never acquire Session attachment or composer custody.
 * Payload validation remains with the incumbent transfer handlers. */
export function hasFilesystemEffectTransferCustody(method: string, input: unknown): boolean {
  const kind: unknown = input && typeof input === 'object' ? Reflect.get(input, 't') : undefined;
  if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) {
    return kind === undefined || kind === 'session_file_upload_v1';
  }
  if (method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
    return kind === undefined || kind === 'session_file_download_v1';
  }
  return true;
}

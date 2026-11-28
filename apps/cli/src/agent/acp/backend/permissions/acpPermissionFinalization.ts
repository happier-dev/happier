/** A turn end keeps requests the provider still waits on past the turn; every other withdrawal ends them all. */
export type AcpPendingPermissionAbortOptions = Readonly<{ keepRetainedPastTurn?: boolean }>;

export type AcpPendingPermissionAbortHandler = Readonly<{
  abortPendingRequestsAndFlush?: (reason: string, options?: AcpPendingPermissionAbortOptions) => Promise<void>;
}>;

export async function abortPendingAcpPermissionRequests(
  permissionHandler: AcpPendingPermissionAbortHandler | null | undefined,
  reason: string,
  onError?: (error: unknown) => void,
  options?: AcpPendingPermissionAbortOptions,
): Promise<void> {
  try {
    await permissionHandler?.abortPendingRequestsAndFlush?.(reason, options);
  } catch (error) {
    onError?.(error);
  }
}

export async function abortPendingAcpPermissionRequests(
  permissionHandler: Readonly<{ abortPendingRequestsAndFlush?: (reason: string) => Promise<void> }> | null | undefined,
  reason: string,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await permissionHandler?.abortPendingRequestsAndFlush?.(reason);
  } catch (error) {
    onError?.(error);
  }
}

export async function reconcileConnectedServicesProjectionForPluginConsumers<TNotification>(
  input: Readonly<{
    notification: TNotification;
    reconcile(notification: TNotification): Promise<void>;
    invalidateConfiguredExternalSessionSources(): void;
    invalidateConnectedAccounts(): void;
  }>,
): Promise<void> {
  try {
    input.invalidateConfiguredExternalSessionSources();
    await input.reconcile(input.notification);
  } finally {
    input.invalidateConnectedAccounts();
  }
}

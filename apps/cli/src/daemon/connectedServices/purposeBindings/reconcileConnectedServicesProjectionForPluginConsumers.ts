export async function reconcileConnectedServicesProjectionForPluginConsumers<TNotification>(
  input: Readonly<{
    notification: TNotification;
    reconcile(notification: TNotification): Promise<void>;
    invalidateConnectedAccounts(): void;
  }>,
): Promise<void> {
  try {
    await input.reconcile(input.notification);
  } finally {
    input.invalidateConnectedAccounts();
  }
}

type ExpoPushTargetLike = string | ReadonlyArray<string>;

type ExpoPushMessageLike = Readonly<{
  to: ExpoPushTargetLike;
}>;

type ExpoPushReceiptsLike = Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>;

function getExpoErrorCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;

  const details = (value as { details?: unknown }).details;
  if (details && typeof details === 'object') {
    const detailsError = (details as { error?: unknown }).error;
    if (typeof detailsError === 'string' && detailsError.trim()) {
      return detailsError.trim();
    }
  }

  const message = (value as { message?: unknown }).message;
  if (typeof message === 'string' && message.trim()) {
    return message.trim();
  }

  return null;
}

function isExpoDeviceNotRegistered(value: unknown): boolean {
  return getExpoErrorCode(value) === 'DeviceNotRegistered';
}

function normalizeExpoPushTargets(target: ExpoPushTargetLike): string[] {
  if (Array.isArray(target)) {
    return target.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }

  return typeof target === 'string' && target.trim().length > 0 ? [target] : [];
}

function readReceiptById(receipts: ExpoPushReceiptsLike | undefined, id: string): unknown {
  if (!receipts) return undefined;
  if (receipts instanceof Map) return receipts.get(id);
  return (receipts as Readonly<Record<string, unknown>>)[id];
}

export function collectExpoPushTokensMarkedUnregistered(params: Readonly<{
  messages: ReadonlyArray<ExpoPushMessageLike>;
  tickets: ReadonlyArray<unknown>;
  receipts?: ExpoPushReceiptsLike;
}>): string[] {
  const invalidTokens = new Set<string>();

  params.tickets.forEach((ticket, index) => {
    const message = params.messages[index];
    if (!message) return;

    if (isExpoDeviceNotRegistered(ticket)) {
      for (const token of normalizeExpoPushTargets(message.to)) invalidTokens.add(token);
      return;
    }

    if (!ticket || typeof ticket !== 'object') return;
    const receiptId = (ticket as { id?: unknown }).id;
    if (typeof receiptId !== 'string' || receiptId.trim().length === 0) return;

    const receipt = readReceiptById(params.receipts, receiptId);
    if (!isExpoDeviceNotRegistered(receipt)) return;

    for (const token of normalizeExpoPushTargets(message.to)) invalidTokens.add(token);
  });

  return [...invalidTokens];
}

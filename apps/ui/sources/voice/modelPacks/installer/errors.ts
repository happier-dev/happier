/** The pack's remaining files would not fit in the device's free space; nothing was downloaded. */
export class ModelPackInsufficientStorageError extends Error {
  constructor(readonly requiredBytes: number, readonly availableBytes: number) {
    super('model_pack_insufficient_storage');
    this.name = 'ModelPackInsufficientStorageError';
  }
}

/** A shared install this caller followed was cancelled by another caller, or by removing the pack. */
export class ModelPackInstallCancelledError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

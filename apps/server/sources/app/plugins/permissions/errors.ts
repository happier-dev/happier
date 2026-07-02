export class PluginPermissionGrantOperationError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "PluginPermissionGrantOperationError";
    }
}

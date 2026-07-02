export class PluginInstallationManifestOperationError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "PluginInstallationManifestOperationError";
    }
}

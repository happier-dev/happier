export class PluginContextServiceError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'PluginContextServiceError';
        this.code = code;
    }
}

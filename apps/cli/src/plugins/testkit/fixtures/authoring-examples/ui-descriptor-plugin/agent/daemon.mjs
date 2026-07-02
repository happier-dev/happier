export async function activate(api) {
    for (const key of ['registerResource', 'registerUiDescriptor', 'registerExecutionRunProfile']) {
        if (key in api) {
            throw new Error(`${key} must be manifest-owned`);
        }
    }
}

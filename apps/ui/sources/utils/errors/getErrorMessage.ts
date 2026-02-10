export function getErrorMessage(err: unknown): string {
    if (err === null || err === undefined) return '';

    if (typeof err === 'string') return err;

    if (err instanceof Error) {
        // Error.message is often the most user-meaningful; fall back to String(err) for empty messages.
        return err.message || String(err);
    }

    if (typeof err === 'object') {
        const maybeMessage = (err as any).message;
        if (typeof maybeMessage === 'string') return maybeMessage;
    }

    return String(err);
}


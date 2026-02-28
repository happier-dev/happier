export function createPierreDiffWorker(): Worker {
    const base = typeof window !== 'undefined' && typeof window.location?.origin === 'string'
        ? window.location.origin
        : (typeof document !== 'undefined' && typeof document.baseURI === 'string'
            ? document.baseURI
            : 'http://localhost');

    const url = new URL('/pierre-diff-worker.js', base);
    return new Worker(url, { type: 'module' });
}

/** Request-local durations only; no query, identity or accounting facts enter diagnostics. */
export class UsageQueryTiming {
    readonly durations = { auth: 0, read: 0, fold: 0, price: 0, project: 0, serialize: 0 };
    readonly startedAt = performance.now();

    measure<T>(phase: keyof UsageQueryTiming['durations'], work: () => T): T {
        const start = performance.now();
        try { return work(); }
        finally { this.durations[phase] += performance.now() - start; }
    }

    header(): string {
        return Object.entries(this.durations).map(([phase, duration]) => `${phase};dur=${duration.toFixed(3)}`).join(', ');
    }
}

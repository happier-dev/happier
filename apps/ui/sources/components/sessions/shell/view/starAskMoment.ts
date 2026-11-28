type Candidate<T> = Readonly<{
    accountId: string;
    active: () => boolean;
    eligible: () => boolean;
    prepare: (signal: AbortSignal) => Promise<T | null>;
    show: (result: T) => void;
    onDisarm?: () => void;
}>;

export function createStarAskMoment<T = 'star'>() {
    const finishedAccounts = new Set<string>();
    let current: {
        candidate: Candidate<T>;
        abort: AbortController;
        prepared?: Promise<T | null>;
        idle: boolean;
    } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function disarm() {
        clearTimeout(timer);
        const previous = current;
        current = null;
        previous?.abort.abort();
        previous?.candidate.onDisarm?.();
    }

    function touch() {
        clearTimeout(timer);
        if (!current) return;
        const armed = current;
        armed.idle = false;
        if (!armed.candidate.active()) return;
        timer = setTimeout(async () => {
            if (current !== armed || !armed.candidate.active()) return;
            armed.idle = true;
            try {
                armed.prepared ??= armed.candidate.prepare(armed.abort.signal);
                const result = await armed.prepared;
                if (current !== armed || !armed.idle || !armed.candidate.active()) return;
                if (result !== null && armed.candidate.eligible()) {
                    finishedAccounts.add(armed.candidate.accountId);
                    armed.candidate.show(result);
                }
                disarm();
            } catch {
                if (current !== armed) return;
                finishedAccounts.add(armed.candidate.accountId);
                disarm();
            }
        }, 30_000);
    }

    return {
        arm(candidate: Candidate<T>): boolean {
            if (finishedAccounts.has(candidate.accountId)) return false;
            disarm();
            current = { candidate, abort: new AbortController(), idle: false };
            touch();
            return true;
        },
        disarm,
        touch,
    };
}

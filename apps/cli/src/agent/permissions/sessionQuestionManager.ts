export type QuestionHandler = Readonly<{ kind: 'person' }> | Readonly<{ kind: 'session'; sessionId: string }>;

/** Facts opened by the bound Session's authenticated transport, not an agent payload. */
export type QuestionSessionSnapshot = Readonly<{
    sessionId: string;
    accountId: string;
    managerSessionId: string | null;
    active?: boolean;
    available: boolean;
    answersWorkerQuestions: boolean;
}>;

export type QuestionSessionReader = (sessionId: string) => Promise<QuestionSessionSnapshot | null>;

export async function resolveOfflineQuestionHandler(input: Readonly<{
    managerSessionId: string;
    readSession: QuestionSessionReader;
}>): Promise<QuestionHandler | null> {
    const manager = await input.readSession(input.managerSessionId);
    return manager?.sessionId === input.managerSessionId && manager.active === false ? { kind: 'person' } : null;
}

export async function resolveInitialQuestionHandler(input: Readonly<{
    sessionId: string;
    lasting: boolean;
    readSession: QuestionSessionReader;
}>): Promise<QuestionHandler> {
    if (input.lasting) return { kind: 'person' };
    const worker = await input.readSession(input.sessionId);
    if (!worker?.managerSessionId || worker.managerSessionId === worker.sessionId) return { kind: 'person' };
    const manager = await input.readSession(worker.managerSessionId);
    return manager && manager.accountId === worker.accountId && manager.available && manager.answersWorkerQuestions
        ? { kind: 'session', sessionId: manager.sessionId }
        : { kind: 'person' };
}

export async function admitManagerQuestionAnswer(input: Readonly<{
    sessionId: string;
    callerSessionId: string;
    accountId: string;
    handler: QuestionHandler;
    question: boolean;
    lasting: boolean;
    readSession: QuestionSessionReader;
}>): Promise<boolean> {
    if (!input.question || input.lasting || input.handler.kind !== 'session'
        || input.handler.sessionId !== input.callerSessionId || input.callerSessionId === input.sessionId) return false;
    const worker = await input.readSession(input.sessionId);
    if (!worker || worker.accountId !== input.accountId) return false;
    const seen = new Set([input.sessionId]);
    let managerId = worker.managerSessionId;
    while (managerId && !seen.has(managerId)) {
        seen.add(managerId);
        const manager = await input.readSession(managerId);
        if (!manager || manager.accountId !== worker.accountId) return false;
        if (manager.sessionId === input.callerSessionId) return manager.answersWorkerQuestions;
        managerId = manager.managerSessionId;
    }
    return false;
}

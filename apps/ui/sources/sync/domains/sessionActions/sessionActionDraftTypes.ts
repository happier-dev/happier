export type SessionActionDraftStatus = 'editing' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type SessionActionDraft = Readonly<{
    id: string;
    sessionId: string;
    actionId: string;
    createdAt: number;
    status: SessionActionDraftStatus;
    input: Record<string, unknown>;
    error?: string | null;
}>;


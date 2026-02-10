export type TaskLifecycleEvent = {
    type: 'task_started' | 'task_complete' | 'turn_aborted';
    id: string;
    createdAt: number;
};

export function getTaskLifecycleEventFromRawContent(content: unknown, createdAt: number): TaskLifecycleEvent | null {
    const rawContent = content as { content?: { type?: string; data?: { type?: string; id?: string } } } | null;
    const contentType = rawContent?.content?.type;
    const dataType = rawContent?.content?.data?.type;
    const dataId = rawContent?.content?.data?.id;

    if (contentType !== 'acp' && contentType !== 'codex') {
        return null;
    }

    if (dataType === 'task_started' || dataType === 'task_complete' || dataType === 'turn_aborted') {
        if (typeof dataId !== 'string' || dataId.length === 0) {
            return null;
        }
        return { type: dataType, id: dataId, createdAt };
    }

    return null;
}

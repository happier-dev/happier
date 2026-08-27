export type TestTerminalAttachmentInfo = Readonly<{
    version: 2;
    attachmentId: string;
    sessionId: string;
    terminal: Readonly<{
        mode: 'plain' | 'tmux' | 'zellij';
        tmux?: Readonly<{ target?: string; tmpDir?: string }>;
        zellij?: Readonly<{ sessionName?: string; paneId?: string }>;
    }>;
    updatedAt: number;
}>;

export function parseTestTerminalAttachmentInfo(raw: string): TestTerminalAttachmentInfo | null {
    try {
        const parsed = JSON.parse(raw) as Partial<TestTerminalAttachmentInfo>;
        if (parsed.version !== 2) return null;
        if (typeof parsed.attachmentId !== 'string' || !parsed.attachmentId) return null;
        if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null;
        if (!parsed.terminal || typeof parsed.terminal !== 'object') return null;
        if (parsed.terminal.mode !== 'plain' && parsed.terminal.mode !== 'tmux' && parsed.terminal.mode !== 'zellij') return null;
        if (typeof parsed.updatedAt !== 'number' || !Number.isFinite(parsed.updatedAt)) return null;
        return parsed as TestTerminalAttachmentInfo;
    } catch {
        return null;
    }
}

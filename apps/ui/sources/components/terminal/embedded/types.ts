export type EmbeddedTerminalPaneStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'exited';

export type EmbeddedTerminalDetectedUrl = Readonly<{
    url: string;
    kind: 'auth' | 'generic';
    suggestOpen?: boolean;
}> | null;

export type EmbeddedTerminalPaneController = Readonly<{
    status: EmbeddedTerminalPaneStatus;
    error: string | null;
    detectedUrl: EmbeddedTerminalDetectedUrl;
    onInput: (data: string) => void;
    onResize: (cols: number, rows: number) => void;
    onReady: (cols: number, rows: number) => void;
    clearTerminal: () => void;
    requestRestart: () => void;
    retryConnect: () => void;
    dismissDetectedUrl: () => void;
}>;

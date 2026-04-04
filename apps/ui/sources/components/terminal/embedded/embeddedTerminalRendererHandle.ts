export type EmbeddedTerminalRendererHandle = Readonly<{
    write: (data: string) => void;
    clear: () => void;
}>;

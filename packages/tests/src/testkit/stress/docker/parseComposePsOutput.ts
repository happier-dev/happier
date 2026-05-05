export type ComposePsEntry = Readonly<{
    ID?: string;
    Name?: string;
    Service?: string;
    State?: string;
    Health?: string;
    ExitCode?: number;
    Status?: string;
}>;

export function parseComposePsOutput(raw: string): ComposePsEntry[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
        return JSON.parse(trimmed) as ComposePsEntry[];
    }
    return trimmed
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ComposePsEntry);
}

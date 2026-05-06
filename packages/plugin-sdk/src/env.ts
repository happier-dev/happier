export interface EnvRuntimeServiceV1 {
    get(name: string): string | null;
    require(name: string): string;
    list(prefix?: string): Readonly<Record<string, string>>;
}

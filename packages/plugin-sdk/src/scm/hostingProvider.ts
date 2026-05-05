export type ScmHostingProviderRuntimeAdapter = Readonly<Record<string, unknown>>;

export type ScmHostingProviderRuntimeRegistration = Readonly<{
    id: string;
    adapter: ScmHostingProviderRuntimeAdapter;
}>;

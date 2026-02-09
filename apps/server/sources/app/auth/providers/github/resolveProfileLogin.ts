export function resolveProfileLogin(params: {
    profile: unknown;
    providerLogin: string | null;
}): string | null {
    const raw: any = params.profile as any;
    if (typeof raw?.login === "string" && raw.login.trim()) {
        return raw.login.trim();
    }
    if (params.providerLogin && params.providerLogin.trim()) {
        return params.providerLogin.trim();
    }
    return null;
}

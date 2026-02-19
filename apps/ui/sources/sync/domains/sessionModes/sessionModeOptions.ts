export type SessionModeOption = Readonly<{
    id: string;
    name: string;
    description?: string;
}>;

export type PreflightSessionModeList = Readonly<{
    availableModes: ReadonlyArray<SessionModeOption>;
}>;

export function getSessionModeOptionsForPreflightModelList(list: PreflightSessionModeList): readonly SessionModeOption[] {
    const dynamic = (list.availableModes ?? [])
        .filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string')
        .map((m) => ({
            id: String(m.id),
            name: String(m.name),
            ...(typeof m.description === 'string' ? { description: m.description } : {}),
        }));

    const withDefault: SessionModeOption[] = [
        { id: 'default', name: 'Default' },
        ...dynamic.filter((m) => m.id !== 'default'),
    ];

    const seen = new Set<string>();
    return withDefault.filter((opt) => {
        if (seen.has(opt.id)) return false;
        seen.add(opt.id);
        return true;
    });
}


import {
    ProjectKeyV1Schema,
    WorkspaceRefV1Schema,
    accountSettingsParse,
    type AccountSettings,
    type ProjectKeyV1,
    type WorkspaceRefV1,
} from '@happier-dev/protocol';
import type {
    AccountSettingsChangeListenerV1,
    AccountSettingsServiceV1,
    ProjectsChangeListenerV1,
    ProjectsServiceV1,
    SubscriptionV1,
} from '@happier-dev/plugin-sdk';

type MaybePromise<T> = T | Promise<T>;

export type WorkspaceRefScopeV1 = Readonly<{
    serverId: string;
    machineId: string;
    rootPath: string;
}>;

type SettingsReader = () => MaybePromise<AccountSettings | null>;
type SettingsListener = (settings: AccountSettings | null) => void;

type ProjectsServiceParams = Readonly<{
    getSettings: SettingsReader;
    getActiveScope?: () => WorkspaceRefScopeV1 | null;
    subscribeSettings?: (listener: SettingsListener) => () => void;
}>;

type AccountSettingsServiceParams = Readonly<{
    getSettings: SettingsReader;
    updateSettings?: (mutate: (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>) => Promise<AccountSettings>;
    subscribeSettings?: (listener: SettingsListener) => () => void;
}>;

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
    return Boolean(value) && typeof (value as Promise<T>).then === 'function';
}

function normalizeIdentifier(value: string): string {
    return value.trim();
}

function normalizeWorkspaceRootPath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) return '';

    const slashNormalized = trimmed.replace(/\\/g, '/');
    const isUncPath = slashNormalized.startsWith('//');
    const collapsed = slashNormalized.replace(/\/+/g, '/');
    const withUncPrefix = isUncPath ? `/${collapsed}` : collapsed;
    const withoutTrailingSlash = withUncPrefix.length > 1
        ? withUncPrefix.replace(/\/+$/g, '')
        : withUncPrefix;
    return /^[a-zA-Z]:\//.test(withoutTrailingSlash) || withoutTrailingSlash.startsWith('//')
        ? withoutTrailingSlash.toLowerCase()
        : withoutTrailingSlash;
}

function normalizeScope(scope: WorkspaceRefScopeV1): WorkspaceRefScopeV1 {
    return Object.freeze({
        serverId: normalizeIdentifier(scope.serverId),
        machineId: normalizeIdentifier(scope.machineId),
        rootPath: normalizeWorkspaceRootPath(scope.rootPath),
    });
}

function readWorkspaceRefs(settings: AccountSettings | null): readonly WorkspaceRefV1[] {
    return accountSettingsParse(settings ?? {}).workspaceRefsV1;
}

async function resolveSettings(getSettings: SettingsReader): Promise<AccountSettings> {
    return accountSettingsParse(await getSettings() ?? {});
}

function findWorkspaceRefByScope(
    workspaceRefs: readonly WorkspaceRefV1[],
    scope: WorkspaceRefScopeV1,
): WorkspaceRefV1 | null {
    const normalizedScope = normalizeScope(scope);
    return workspaceRefs.find((ref) => {
        const normalizedRefScope = normalizeScope({
            serverId: ref.serverId,
            machineId: ref.machineId,
            rootPath: ref.rootPath,
        });
        return normalizedRefScope.serverId === normalizedScope.serverId
            && normalizedRefScope.machineId === normalizedScope.machineId
            && normalizedRefScope.rootPath === normalizedScope.rootPath;
    }) ?? null;
}

function findWorkspaceRef(workspaceRefs: readonly WorkspaceRefV1[], key: ProjectKeyV1): WorkspaceRefV1 | null {
    const parsedKey = ProjectKeyV1Schema.parse(key);
    if ('id' in parsedKey) {
        const id = normalizeIdentifier(parsedKey.id);
        return workspaceRefs.find((ref) => normalizeIdentifier(ref.id) === id) ?? null;
    }
    return findWorkspaceRefByScope(workspaceRefs, parsedKey);
}

function createSubscription(unsubscribeSource: () => void): SubscriptionV1 {
    let unsubscribed = false;
    return Object.freeze({
        unsubscribe: () => {
            if (unsubscribed) return;
            unsubscribed = true;
            unsubscribeSource();
        },
    });
}

function notifyProjectsChangeListener(
    listener: ProjectsChangeListenerV1,
    workspaceRefs: readonly WorkspaceRefV1[],
): void {
    try {
        listener(workspaceRefs);
    } catch {
        // Plugin callbacks must not break host settings delivery.
    }
}

function notifyAccountSettingsChangeListener(
    listener: AccountSettingsChangeListenerV1,
    settings: AccountSettings,
): void {
    try {
        listener(settings);
    } catch {
        // Plugin callbacks must not break host settings delivery.
    }
}

function validateSettingValueForWrite(key: string, value: unknown): unknown {
    if (key !== 'workspaceRefsV1') {
        return value;
    }
    const parsed = WorkspaceRefV1Schema.array().safeParse(value);
    if (!parsed.success) {
        throw new Error('ctx.account.settings.set received invalid workspaceRefsV1');
    }
    return parsed.data;
}

export function createProjectsService(params: ProjectsServiceParams): ProjectsServiceV1 {
    const listAll = async (): Promise<readonly WorkspaceRefV1[]> => {
        const settings = await resolveSettings(params.getSettings);
        return readWorkspaceRefs(settings);
    };

    const listForScope = async (scope: WorkspaceRefScopeV1 | null): Promise<readonly WorkspaceRefV1[]> => {
        if (!scope) return [];
        const normalizedScope = normalizeScope(scope);
        const workspaceRefs = await listAll();
        return workspaceRefs.filter((ref) => {
            const normalizedRefScope = normalizeScope({
                serverId: ref.serverId,
                machineId: ref.machineId,
                rootPath: ref.rootPath,
            });
            return normalizedRefScope.serverId === normalizedScope.serverId
                && normalizedRefScope.machineId === normalizedScope.machineId;
        });
    };

    return Object.freeze({
        listAll,
        listForCurrentMachine: async () => listForScope(params.getActiveScope?.() ?? null),
        listForMachine: async (machineId: string) => {
            const normalizedMachineId = normalizeIdentifier(machineId);
            const workspaceRefs = await listAll();
            return workspaceRefs.filter((ref) => normalizeIdentifier(ref.machineId) === normalizedMachineId);
        },
        get: async (key: ProjectKeyV1) => findWorkspaceRef(await listAll(), key),
        getActive: async () => {
            const scope = params.getActiveScope?.() ?? null;
            return scope ? findWorkspaceRefByScope(await listAll(), scope) : null;
        },
        watch: (listener: ProjectsChangeListenerV1) => {
            let disposed = false;
            const emit = (settings: AccountSettings | null) => {
                if (!disposed) notifyProjectsChangeListener(listener, readWorkspaceRefs(settings));
            };
            const initial = params.getSettings();
            if (isPromiseLike(initial)) {
                void initial.then(emit).catch(() => emit(null));
            } else {
                emit(initial);
            }
            const unsubscribeSource = params.subscribeSettings?.(emit) ?? (() => undefined);
            return createSubscription(() => {
                disposed = true;
                unsubscribeSource();
            });
        },
    });
}

function settingsToRecord(settings: AccountSettings): Record<string, unknown> {
    return { ...(settings as unknown as Record<string, unknown>) };
}

export function createAccountSettingsService(params: AccountSettingsServiceParams): AccountSettingsServiceV1 {
    async function get(): Promise<AccountSettings>;
    async function get(key: string): Promise<unknown>;
    async function get(key?: string): Promise<unknown> {
        const settings = await resolveSettings(params.getSettings);
        if (key === undefined) return settings;
        return settingsToRecord(settings)[key];
    }

    return Object.freeze({
        get,
        set: async (key: string, value: unknown): Promise<void> => {
            const normalizedKey = normalizeIdentifier(key);
            if (!normalizedKey) {
                throw new Error('ctx.account.settings.set requires a non-empty setting key');
            }
            if (!params.updateSettings) {
                throw new Error('ctx.account.settings.set is unavailable until account settings credentials are loaded');
            }
            const validatedValue = validateSettingValueForWrite(normalizedKey, value);
            await params.updateSettings((settings) => {
                const parsed = accountSettingsParse(settings);
                const next = {
                    ...settingsToRecord(parsed),
                    [normalizedKey]: validatedValue,
                };
                return settingsToRecord(accountSettingsParse(next));
            });
        },
        onChange: (listener: AccountSettingsChangeListenerV1) => {
            let disposed = false;
            const emit = (settings: AccountSettings | null) => {
                if (!disposed) notifyAccountSettingsChangeListener(listener, accountSettingsParse(settings ?? {}));
            };
            const initial = params.getSettings();
            if (isPromiseLike(initial)) {
                void initial.then(emit).catch(() => emit(null));
            } else {
                emit(initial);
            }
            const unsubscribeSource = params.subscribeSettings?.(emit) ?? (() => undefined);
            return createSubscription(() => {
                disposed = true;
                unsubscribeSource();
            });
        },
    });
}

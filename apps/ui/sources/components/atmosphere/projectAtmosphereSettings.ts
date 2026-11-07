import type { HomeAtmosphere, ProjectAtmosphere, AtmospherePresentation } from '@happier-dev/protocol/account/settings/accountSettings';
import type { SettingsMutationServices } from '@/components/settings/catalog/settingDeclarations';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { projectAtmosphereEdit } from './look/projectAtmosphereEdit';

type ProjectAtmosphereContext = Readonly<{
    rows: NonNullable<SettingsMutationServices['projectAccountRows']>;
    scope: ServerAccountScope | undefined;
    target: Readonly<{ serverId: string; projectKey: string }>;
    signal?: AbortSignal;
    isCurrent(): boolean;
}>;
const pendingWrites = new Map<string, Promise<void>>();

/** Project Settings and Look share the same captured row/CAS boundary. */
export async function readProjectAtmosphereSetting(context: ProjectAtmosphereContext) {
    if (!context.isCurrent()) return null;
    const snapshot = await context.rows.read(context.signal);
    if (!context.isCurrent() || !context.scope || snapshot.scope.serverId !== context.target.serverId
        || snapshot.scope.accountId !== context.scope.accountId || context.scope.serverId !== context.target.serverId
        || snapshot.status !== 'ready' || snapshot.coverage !== 'complete') return null;
    const row = snapshot.organizations.find(row => row.key.serverId === context.target.serverId && row.key.projectKey === context.target.projectKey);
    return { row, value: row?.value.atmosphere ?? 'home' as const };
}

/** Reapply an intent to the row owner's fresh value, preserving every other Project field. */
export async function mutateProjectAtmosphereSetting(context: ProjectAtmosphereContext & Readonly<{
    readHome(): Promise<HomeAtmosphere>;
    edit: 'home' | ((value: ProjectAtmosphere) => ProjectAtmosphere);
    /** The actual available Home picture when a person materializes an inherited presentation. */
    shownHomePicture?: AtmospherePresentation['picture']['ref'];
}>) {
    if (!context.isCurrent() || !context.scope || context.scope.serverId !== context.target.serverId)
        return { status: 'unavailable' as const };
    // The row's order survives closing or reopening an editor, and applies to every Settings ingress.
    const key = JSON.stringify([context.scope.serverId, context.scope.accountId, context.target.projectKey]);
    const previous = pendingWrites.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
        if (!context.isCurrent()) return { status: 'unavailable' as const };
        // Literal inheritance stores no Home content; only an override edit consumes that baseline.
        const home = context.edit === 'home' ? undefined : await context.readHome();
        if (!context.isCurrent()) return { status: 'unavailable' as const };
        const result = await context.rows.mutateOrganization({ ...context.target, signal: context.signal,
            mutate: value => {
                if (!context.isCurrent()) throw new Error('project_account_scope_changed');
                return { ...value, atmosphere: context.edit === 'home' ? 'home'
                    : projectAtmosphereEdit(home!, value.atmosphere, context.edit, context.shownHomePicture) };
            } });
        if (!context.isCurrent()) return { status: 'unavailable' as const };
        return result.status === 'updated' ? { status: 'updated' as const, value: result.value.atmosphere ?? 'home' as const }
            : { status: 'conflict' as const };
    });
    const settled = result.then(() => {}, () => {});
    pendingWrites.set(key, settled);
    void settled.then(() => { if (pendingWrites.get(key) === settled) pendingWrites.delete(key); });
    return result;
}

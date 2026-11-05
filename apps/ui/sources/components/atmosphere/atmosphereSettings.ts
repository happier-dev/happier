import { releaseLook, type AtmosphereLookPicture } from '@happier-dev/brand/atmosphere';
import { DEFAULT_HOME_ATMOSPHERE, HomeAtmosphereSchema, AtmospherePresentationSchema, atmospherePresentation, applyAtmosphereLayoutDefault,
    type HomeAtmosphere, type ProjectAtmosphere, type AtmospherePresentation } from '@happier-dev/protocol/account/settings/accountSettings';
import { buildBuiltInAccountSettingMutationV1, parseBuiltInAccountSettingValueV1,
    readBuiltInAccountSettingValueV1, readBuiltInSettingDeclarationV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';
import type { SettingStorageBinding, SettingOperationContext, SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import type { Settings, SettingsWriteDelta } from '@/sync/domains/settings/settings';
import { randomUUID } from '@/platform/randomUUID';
import { readAtmospherePictureCatalog } from './pictureCatalog';

/** One sparse representation, shared by Look controls and Settings Actions. */
export function normalizeAtmosphereLooks(looks: HomeAtmosphere['looks'], pictures: readonly AtmosphereLookPicture[] = readAtmospherePictureCatalog()): HomeAtmosphere['looks'] {
    const entries = Object.entries(looks).flatMap(([id, look]) => {
        const picture = pictures.find(picture => picture.id === id);
        // Catalog absence is a rendering fallback, never authority to erase synced choices.
        if (!picture) return [[id, look] as const];
        const base = releaseLook(picture);
        const sparse = { ...look };
        if (sparse.look === base.effect) delete sparse.look;
        if (sparse.strength === base.strength) delete sparse.strength;
        if (sparse.dissolve === base.fade) delete sparse.dissolve;
        return Object.keys(sparse).length ? [[id, sparse] as const] : [];
    });
    return Object.fromEntries(entries);
}

export function normalizeHomeAtmosphere(value: HomeAtmosphere): HomeAtmosphere {
    return { ...value, looks: normalizeAtmosphereLooks(value.looks) };
}
export function normalizeProjectAtmosphere(value: ProjectAtmosphere): ProjectAtmosphere {
    return { ...value, looks: normalizeAtmosphereLooks(value.looks) };
}

/** Shared declaration parsing/editing with contextual storage owned by the captured controller. */
export function readAtmospherePresentationSetting(value: AtmospherePresentation, anchor: string): unknown {
    const declaration = readBuiltInSettingDeclarationV1(anchor);
    return anchor === 'appearance.homeAtmosphere' ? atmospherePresentation(value) : anchor === 'appearance.atmosphereLooks' ? value.looks
        : declaration ? readBuiltInAccountSettingValueV1(declaration, { homeAtmosphere: value }) : undefined;
}

export function editAtmospherePresentationSetting(current: AtmospherePresentation, anchor: string, value: unknown): AtmospherePresentation | null {
    if (anchor === 'appearance.homeAtmosphere') {
        const parsed = AtmospherePresentationSchema.safeParse(value);
        return parsed.success ? { ...parsed.data, looks: normalizeAtmosphereLooks(parsed.data.looks) } : null;
    }
    const declaration = readBuiltInSettingDeclarationV1(anchor);
    if (!declaration) return null;
    const delta = buildBuiltInAccountSettingMutationV1(declaration, { homeAtmosphere: { ...DEFAULT_HOME_ATMOSPHERE, ...current } }, value);
    const home = HomeAtmosphereSchema.safeParse(delta?.homeAtmosphere);
    const parsed = anchor === 'appearance.atmosphereLooks' ? AtmospherePresentationSchema.safeParse({ ...current, looks: value })
        : home.success ? AtmospherePresentationSchema.safeParse(atmospherePresentation(home.data)) : null;
    return parsed?.success ? { ...parsed.data, looks: normalizeAtmosphereLooks(parsed.data.looks) } : null;
}

/** Nested intents are reapplied to the latest Account snapshot by the incumbent CAS owner. */
export function buildHomeAtmosphereControlMutation(settings: Settings, anchor: string, value: unknown): SettingsWriteDelta | null {
    const declaration = readBuiltInSettingDeclarationV1(anchor);
    if (!declaration) return null;
    const delta = buildBuiltInAccountSettingMutationV1(declaration, settings, value);
    if (!delta) return null;
    const parsed = HomeAtmosphereSchema.safeParse(delta.homeAtmosphere);
    return parsed.success ? { homeAtmosphere: normalizeHomeAtmosphere(applyAtmosphereLayoutDefault(settings.homeAtmosphere, parsed.data)) } : null;
}

/** Full object and look-map writes need the picture release catalog; portable discovery routes them to this client owner. */
export function homeAtmosphereStorageBinding(anchor: 'appearance.homeAtmosphere' | 'appearance.atmosphereLooks'): SettingStorageBinding {
    const isLooks = anchor === 'appearance.atmosphereLooks';
    return { scope: 'account', kind: 'owner', access: 'read_write', resetValue: isLooks ? {} : DEFAULT_HOME_ATMOSPHERE,
        read: settings => isLooks ? settings.homeAtmosphere.looks : settings.homeAtmosphere,
        parse: value => {
            const parsed = HomeAtmosphereSchema.safeParse(isLooks ? { ...DEFAULT_HOME_ATMOSPHERE, looks: value } : value);
            if (!parsed.success) return { success: false };
            const normalized = normalizeHomeAtmosphere(parsed.data);
            return { success: true, value: isLooks ? normalized.looks : normalized };
        },
        mutate: (settings, value) => {
            const parsed = HomeAtmosphereSchema.safeParse(isLooks ? { ...settings.homeAtmosphere, looks: value } : value);
            return parsed.success ? { homeAtmosphere: normalizeHomeAtmosphere(applyAtmosphereLayoutDefault(settings.homeAtmosphere, parsed.data)) } : null;
        },
    };
}

export function atmosphereFieldStorageBinding(anchor: string): SettingStorageBinding {
    const declaration = readBuiltInSettingDeclarationV1(anchor);
    if (!declaration) throw new Error('Atmosphere setting is undeclared');
    return { scope: 'account', kind: 'owner', access: 'read_write',
        read: settings => readBuiltInAccountSettingValueV1(declaration, settings),
        parse: value => parseBuiltInAccountSettingValueV1(declaration, value),
        mutate: (settings, value) => buildHomeAtmosphereControlMutation(settings, anchor, value),
    };
}

/** The one way a user picture enters this device's store (the Look picker and the Settings Action). */
export function storeUserAtmospherePicture(data: Blob | string): Promise<string>;
export function storeUserAtmospherePicture(data: Blob | string, isCurrent: () => boolean): Promise<string | null>;
export async function storeUserAtmospherePicture(data: Blob | string, isCurrent: () => boolean = () => true): Promise<string | null> {
    const { pictureStore } = await import('./pictureStore');
    if (!isCurrent()) return null;
    const prepared = await pictureStore.prepare(data);
    if (!isCurrent()) return null;
    const localId = randomUUID();
    await pictureStore.put({ localId, kind: 'user', data: prepared });
    return localId;
}

/** Acquisition returns bytes on both web and native; a remote URL is never treated as a native file URI. */
export async function invokeAtmospherePictureOperation(operation: 'add' | 'remove', context: SettingOperationContext): Promise<SettingOperationResult> {
    const input = context.input;
    if (input?.kind !== (operation === 'add' ? 'atmosphere_picture_add' : 'atmosphere_picture_remove')) {
        return { status: 'unavailable', reason: 'picture_operation_input_required' };
    }
    if (!context.isCurrent()) return { status: 'cancelled' };
    const { pictureStore } = await import('./pictureStore');
    if (!context.isCurrent()) return { status: 'cancelled' };
    if (input?.kind === 'atmosphere_picture_add') {
        const projectRows = context.target?.kind === 'project' ? context.services?.projectAccountRows : undefined;
        if (context.target?.kind === 'project' && (!projectRows || !context.accountScope)) return { status: 'unavailable', reason: 'project_account_unavailable' };
        let data: Blob | string;
        if (input.source.kind === 'picked') {
            const pick = context.services?.pickAtmospherePicture;
            if (!pick) return { status: 'unavailable', reason: 'picture_picker_unavailable' };
            const picked = await pick(context.signal);
            if (!context.isCurrent() || picked === null) return { status: 'cancelled' };
            data = picked;
        } else if (input.source.kind === 'url') {
            const response = await fetch(input.source.url, { signal: context.signal });
            if (!response.ok) return { status: 'unavailable', reason: 'picture_download_failed' };
            data = await response.blob();
        } else {
            const read = context.services?.readAtmospherePictureFile;
            if (!read) return { status: 'unavailable', reason: 'picture_file_transport_unavailable' };
            const result = await read(input.source, context.signal);
            if (!result.success) return { status: 'unavailable', reason: 'picture_file_read_failed' };
            // readFile's established contract is base64 binary bytes, not UTF-8 text.
            data = `data:application/octet-stream;base64,${result.content}`;
        }
        if (!context.isCurrent()) return { status: 'cancelled' };
        const localId = await storeUserAtmospherePicture(data, context.isCurrent);
        if (localId === null || !context.isCurrent()) return { status: 'cancelled' };
        const select = <T extends AtmospherePresentation>(value: T): T => ({ ...value, source: 'picture',
            picture: { ...value.picture, ref: { kind: 'user', localId } } });
        if (context.target?.kind === 'public_profile_draft') {
            const draft = context.services?.publicProfileAtmosphereDraft;
            if (!draft?.isCurrent() || draft.serverId !== context.target.serverId) return { status: 'cancelled' };
            await draft.update(value => context.isCurrent() && draft.isCurrent() ? select(value) : value);
        } else if (context.target?.kind === 'project' && projectRows) {
            const { mutateProjectAtmosphereSetting } = await import('./projectAtmosphereSettings');
            const result = await mutateProjectAtmosphereSetting({ rows: projectRows, scope: context.accountScope, target: context.target,
                signal: context.signal, isCurrent: context.isCurrent, readHome: async () => (await context.readSettings()).homeAtmosphere, edit: select });
            if (result.status !== 'updated') return { status: 'unavailable', reason: result.status === 'conflict'
                ? 'project_account_mutation_conflict' : 'project_account_unavailable' };
        } else {
            await context.mutateSettings(settings => ({ homeAtmosphere: select(settings.homeAtmosphere) }));
        }
        if (!context.isCurrent()) return { status: 'cancelled' };
        return { status: 'completed', value: { localId } };
    }
    if (input?.kind === 'atmosphere_picture_remove') {
        const existing = await pictureStore.get(input.localId);
        if (!context.isCurrent()) return { status: 'cancelled' };
        if (!existing || existing.kind !== 'user') return { status: 'unavailable', reason: 'user_picture_not_found' };
        await pictureStore.remove(input.localId);
        // Synced references remain authored intent; devices without bytes use the canonical default fallback.
        return { status: 'completed', value: { localId: input.localId } };
    }
    return { status: 'unavailable', reason: 'picture_operation_input_required' };
}

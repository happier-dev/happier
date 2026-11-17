import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { RegistryItemPointerV1 } from '@happier-dev/protocol/registries/registryContentRefV1';
import type { RegistryThemeAcquisitionV1 } from '@happier-dev/protocol/registries/registryThemeV1';
import type { ThemeLibraryMutationResult, ThemeProfileDocument, ThemeProfileLibrary, ThemeProfileMode, ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import { randomUUID } from '@/platform/randomUUID';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { retainDeep } from '@/sync/domains/state/structuralSharing';

/** Opaque client-local reference; validity is decided by this owner's current preview. */
export type PreviewRef = string;
export type ThemeTryOnOrigin =
    | Readonly<{ kind: 'agent' | 'editor' }>
    | Readonly<{ kind: 'store'; listing: Pick<RegistryItemPointerV1, 'sourceId' | 'itemId'>; acquired?: RegistryThemeAcquisitionV1 }>;
export type ThemeTryOnInput = Readonly<{
    mode: ThemeProfileMode;
    origin: ThemeTryOnOrigin;
    group?: string;
}> & (Readonly<{ document: ThemeProfileDocument; selection?: ThemeReference | null }>
    | Readonly<{ document: null; selection: null }>);
export type ThemeTryOnSnapshot = ThemeTryOnInput & Readonly<{ previewRef: PreviewRef }>;
export interface ThemeTryOnOwner {
    begin(input: ThemeTryOnInput): ThemeTryOnSnapshot;
    replace(previewRef: PreviewRef, input: ThemeTryOnInput): ThemeTryOnSnapshot;
    read(): ThemeTryOnSnapshot | null;
    revert(previewRef: PreviewRef): void;
    keep(previewRef: PreviewRef): Promise<ThemeLibraryMutationResult>;
    subscribe(listener: () => void): () => void;
}

/** One overlay, composed once by the device's theme runtime; no library snapshot is retained. */
export function createThemeTryOnOwner(deps: Readonly<{
    captureScope(): AccountSettingsScope | null;
    keep(input: Parameters<ThemeProfileLibrary['keep']>[0], scope: AccountSettingsScope): Promise<ThemeLibraryMutationResult>;
    select(input: Parameters<ThemeProfileLibrary['select']>[0], scope: AccountSettingsScope): Promise<ThemeLibraryMutationResult>;
    installStore(snapshot: ThemeTryOnSnapshot, scope: AccountSettingsScope): Promise<ThemeLibraryMutationResult>;
}>): ThemeTryOnOwner {
    let current: { snapshot: ThemeTryOnSnapshot; scope: AccountSettingsScope | null; keeping?: Promise<ThemeLibraryMutationResult> } | null = null;
    const listeners = new Set<() => void>();
    const publish = () => { for (const listener of listeners) listener(); };
    const requireCurrent = (previewRef: PreviewRef) => {
        if (!current || current.snapshot.previewRef !== previewRef) {
            throw createActionExecuteFailureError({ ok: false, errorCode: 'theme_preview_stale', error: 'theme_preview_stale' });
        }
        return current;
    };
    const requireScopedCurrent = (previewRef: PreviewRef) => {
        const preview = requireCurrent(previewRef);
        const scope = preview.scope;
        if (!scope || !areAccountSettingsScopesEqual(scope, deps.captureScope())) {
            throw new Error('Artifact Account scope is unavailable');
        }
        return { preview, scope };
    };
    const begin = (input: ThemeTryOnInput): ThemeTryOnSnapshot => {
        const scope = deps.captureScope();
        const previous = current && areAccountSettingsScopesEqual(current.scope, scope) ? current.snapshot : undefined;
        const retained = retainDeep<ThemeTryOnSnapshot>(previous,
            { ...input, previewRef: previous?.previewRef ?? randomUUID() });
        if (retained === previous) return retained;
        const snapshot: ThemeTryOnSnapshot = previous ? { ...retained, previewRef: randomUUID() } : retained;
        current = { snapshot, scope };
        publish();
        return snapshot;
    };
    return {
        begin,
        replace(previewRef, input) { requireScopedCurrent(previewRef); return begin(input); },
        read: () => current && areAccountSettingsScopesEqual(current.scope, deps.captureScope()) ? current.snapshot : null,
        revert(previewRef) { requireCurrent(previewRef); current = null; publish(); },
        async keep(previewRef) {
            const { preview, scope } = requireScopedCurrent(previewRef);
            if (!preview.keeping) {
                preview.keeping = Promise.resolve().then(() => {
                    const snapshot = preview.snapshot;
                    if (snapshot.document === null || snapshot.selection !== undefined) {
                        return deps.select({ reference: snapshot.selection ?? null, mode: snapshot.mode }, scope);
                    }
                    if (snapshot.origin.kind === 'store') return deps.installStore(snapshot, scope);
                    return deps.keep({ document: snapshot.document, mode: snapshot.mode }, scope);
                })
                    .then(result => {
                        if (current === preview) { current = null; publish(); }
                        return result;
                    }).finally(() => { preview.keeping = undefined; });
            }
            return preview.keeping;
        },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
}

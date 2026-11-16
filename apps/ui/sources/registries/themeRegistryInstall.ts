import { mergeThemeProfileDocumentEdit, type ThemeLibraryMutationResult, type ThemeProfileMode } from '@happier-dev/protocol/account/settings/themeProfiles';
import { createActionExecuteFailureError, readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { RegistryItemPointerV1 } from '@happier-dev/protocol/registries/registryContentRefV1';
import { createThemeProfileLibrary, createThemeProfileSourceAdapter, type ThemeProfileLibraryContext } from '@/theme/profiles/themeProfileLibrary';
import type { RegistryThemeAcquisitionV1 } from '@happier-dev/protocol/registries/registryThemeV1';
import type { ThemeTryOnSnapshot } from '@/theme/profiles/themeTryOn';
import type { ThemeInstallFaceOutcome, ThemeInstallResult, ThemeRegistryItemKey } from '@happier-dev/protocol/actions/themeActionFamily';
export type { ThemeInstallFaceOutcome, ThemeInstallResult, ThemeRegistryItemKey } from '@happier-dev/protocol/actions/themeActionFamily';

export type AcquiredRegistryTheme = RegistryThemeAcquisitionV1;

/** Registry admission/acquisition and MODEL persistence retain their own authorities. */
export function createThemeRegistryLifecycle(deps: Readonly<{
    withThemeProfileContext<TResult>(operation: (context: ThemeProfileLibraryContext) => Promise<TResult>): Promise<TResult>;
    acquire(listing: ThemeRegistryItemKey & Partial<Pick<RegistryItemPointerV1, 'version'>>): Promise<AcquiredRegistryTheme>;
    readMode(): ThemeProfileMode;
    revertStorePreview(listing: ThemeRegistryItemKey): void;
}>) {
    let opened: AcquiredRegistryTheme | null = null;
    const matches = (acquired: AcquiredRegistryTheme, listing: ThemeRegistryItemKey & Partial<Pick<RegistryItemPointerV1, 'version'>>) =>
        acquired.item.summary.sourceId === listing.sourceId && acquired.item.summary.itemId === listing.itemId
        && (listing.version === undefined || acquired.item.summary.version === listing.version);
    const get = async (listing: ThemeRegistryItemKey & Partial<Pick<RegistryItemPointerV1, 'version'>>): Promise<AcquiredRegistryTheme> => {
        const acquired = await deps.acquire(listing);
        opened = { ...acquired, item: { ...acquired.item, payload: { ...acquired.item.payload,
            themes: acquired.item.payload.themes.map(face => ({ ...face, document: mergeThemeProfileDocumentEdit(face.document, {
                source: { kind: 'store', provenance: acquired.provenance, contributionId: face.key },
            }) })),
        } } };
        return opened;
    };
    const prepareStorePreview = (listing: ThemeRegistryItemKey & Partial<Pick<RegistryItemPointerV1, 'version'>>) =>
        opened && matches(opened, listing) ? Promise.resolve(opened) : get(listing);
    const installFaces = (input: Readonly<{
        listing: ThemeRegistryItemKey;
        acquired?: AcquiredRegistryTheme;
        faceIds?: readonly string[];
        selectedFaceId?: string;
    }>) => deps.withThemeProfileContext(async context => {
        const library = createThemeProfileLibrary(context);
        const source = createThemeProfileSourceAdapter(context);
        const acquired = input.acquired ?? await prepareStorePreview(input.listing);
        const unknownFace = input.faceIds?.some(id => !acquired.item.payload.themes.some(face => face.key === id));
        if (unknownFace || input.selectedFaceId !== undefined && !acquired.item.payload.themes.some(face => face.key === input.selectedFaceId)) {
            throw createActionExecuteFailureError({ ok: false, errorCode: 'theme_not_found', error: 'theme_not_found' });
        }
        const outcomes: ThemeInstallFaceOutcome[] = [];
        const selected = acquired.item.payload.themes.filter(face => input.faceIds === undefined || input.faceIds.includes(face.key));
        for (const face of selected) {
            try {
                const document = mergeThemeProfileDocumentEdit(face.document, {
                    source: { kind: 'store', provenance: acquired.provenance, contributionId: face.key },
                });
                const result = await source.save(document);
                if (!result.entry) throw createActionExecuteFailureError({ ok: false, errorCode: 'theme_not_found', error: 'theme_not_found' });
                outcomes.push({ faceId: face.key, status: 'saved', entry: result.entry });
            } catch (error) {
                outcomes.push({ faceId: face.key, status: 'failed', error: { code: readActionErrorCodeV1(error) ?? 'action_failed' } });
            }
        }
        if (outcomes.some(outcome => outcome.status === 'failed')) {
            throw createActionExecuteFailureError({ ok: false, errorCode: 'theme_install_partial', error: 'theme_install_partial', details: { faces: outcomes } });
        }
        const selectedFaceId = input.selectedFaceId ?? selected.find(face => face.mode === deps.readMode())?.key ?? selected[0]?.key;
        const tried = outcomes.find(outcome => outcome.faceId === selectedFaceId);
        let selection: ThemeLibraryMutationResult | undefined;
        if (tried?.status === 'saved') {
            const face = selected.find(face => face.key === tried.faceId)!;
            selection = await library.select({ mode: face.mode, reference: tried.entry.reference });
        }
        return { faces: outcomes, selection };
    });
    const install = async (input: Parameters<typeof installFaces>[0]): Promise<ThemeInstallResult> => ({ faces: (await installFaces(input)).faces });
    const keepStore = async (snapshot: ThemeTryOnSnapshot): Promise<ThemeLibraryMutationResult> => {
        if (snapshot.origin.kind !== 'store' || !snapshot.document || snapshot.document.profile.source?.kind !== 'store') {
            throw createActionExecuteFailureError({ ok: false, errorCode: 'theme_not_found', error: 'theme_not_found' });
        }
        const { provenance, contributionId } = snapshot.document.profile.source;
        const acquired = snapshot.origin.acquired ?? await prepareStorePreview({ ...snapshot.origin.listing, ...(provenance.ref.kind === 'version' ? { version: provenance.ref.version } : {}) });
        const result = await installFaces({ listing: snapshot.origin.listing, acquired, selectedFaceId: contributionId });
        if (!result.selection?.entry) throw createActionExecuteFailureError({ ok: false, errorCode: 'theme_not_found', error: 'theme_not_found' });
        return result.selection;
    };
    const uninstall = (listing: ThemeRegistryItemKey) => deps.withThemeProfileContext(async context => {
        const source = createThemeProfileSourceAdapter(context);
        deps.revertStorePreview(listing);
        const installed = (await source.list()).filter(entry => entry.source.kind === 'store'
            && entry.source.provenance.sourceId === listing.sourceId && entry.source.provenance.itemId === listing.itemId);
        const removedFaces: string[] = [];
        for (const entry of installed) {
            await source.delete(entry.id);
            if (entry.source.kind === 'store') removedFaces.push(entry.source.contributionId);
        }
        return { removedFaces };
    });
    return { get, prepareStorePreview, install, uninstall, keepStore };
}

export type ThemeRegistryLifecycle = ReturnType<typeof createThemeRegistryLifecycle>;

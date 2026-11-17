import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { clientActionUnavailable } from '@happier-dev/protocol/actions/clientDispatchV1';
import type { ThemeActionRequest, ThemeCssCoverage, ThemeCssDetailedCoverage } from '@happier-dev/protocol/actions/themeActionFamily';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { mergeThemeProfileDocumentEdit, type ThemeProfileLibrary, type ThemeProfileMode, type ThemeReference, type ThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';

import { importThemeProfileFromJson, exportThemeProfileToJson } from '@/theme/profiles/themeProfileImportExport';
import { createShareThemePlugin } from '@/theme/profiles/shareThemePlugin';
import type { BoundThemeRegistryLifecycle } from '@/registries/themeRegistryInstall';
import { prepareThemeProfileCssAsync } from '@/theme/css/prepareThemeCss';

import type { ThemeTryOnOrigin, ThemeTryOnOwner } from '@/theme/profiles/themeTryOn';
import type { ThemeSurfacePaintDescriptor } from '@happier-dev/plugin-ui';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { THEME_PROFILE_TOKEN_DEFINITIONS } from '@/theme/profiles/themeProfileTokenRegistry';

export interface ThemeActionRuntime {
    preview: ThemeTryOnOwner;
    coverage(document: ThemeProfileDocument): ThemeCssCoverage;
    detailedCoverage(document: ThemeProfileDocument): ThemeCssDetailedCoverage;
    surfaceMap?(document: ThemeProfileDocument, mode: ThemeProfileMode): readonly ThemeSurfacePaintDescriptor[];
}

/** The capturing Action host supplies the Account-scoped library and live socket id. */
export interface ThemeActionHost {
    withLibrary<TResult>(operation: (library: ThemeProfileLibrary) => Promise<TResult>, signal?: AbortSignal): Promise<TResult>;
    runtime?: ThemeActionRuntime;
    clientId(): string;
    readSelection(): Readonly<Record<ThemeProfileMode, ThemeReference | null>>;
    withRegistryLifecycle?<TResult>(operation: (lifecycle: Pick<BoundThemeRegistryLifecycle, 'get' | 'prepareStorePreview' | 'install' | 'uninstall'>) => Promise<TResult>, context: ActionExecutorContext): Promise<TResult>;
    dispatchClientAction?(request: Extract<ThemeActionRequest, { actionId: typeof THEME_ACTION_IDS.list }>): ReturnType<NonNullable<ActionExecutorDeps['themeAction']>>;
}

export function createThemeActionExecute(host: ThemeActionHost): NonNullable<ActionExecutorDeps['themeAction']> {
    return async request => {
        if (request.actionId === THEME_ACTION_IDS.storeGet || request.actionId === THEME_ACTION_IDS.install
            || request.actionId === THEME_ACTION_IDS.uninstall) {
            if (!host.withRegistryLifecycle) return clientActionUnavailable(request.actionId);
            return host.withRegistryLifecycle(async lifecycle => {
                switch (request.actionId) {
                    case THEME_ACTION_IDS.storeGet: {
                        const acquired = await lifecycle.get(request.input.listing);
                        const { summary, payload } = acquired.item;
                        return { listing: { pointer: { sourceId: summary.sourceId, itemId: summary.itemId, version: payload.version },
                            summary, metadata: payload.listing, provenance: acquired.provenance },
                            faces: payload.themes.map(face => face.document),
                            coverage: await Promise.all(payload.themes.map(async face => ({ faceId: face.key,
                                coverage: (await prepareThemeProfileCssAsync(face.document.profile)).coverage }))) };
                    }
                    case THEME_ACTION_IDS.install:
                        return lifecycle.install(request.input);
                    case THEME_ACTION_IDS.uninstall:
                        return lifecycle.uninstall(request.input.listing);
                }
            }, request.context);
        }
        if (request.actionId === THEME_ACTION_IDS.list && request.input.includeDevices) {
            return host.dispatchClientAction ? await host.dispatchClientAction(request)
                : clientActionUnavailable(request.actionId);
        }
        return await host.withLibrary(async library => {
            switch (request.actionId) {
                case THEME_ACTION_IDS.list: {
                    const entries = await library.list();
                    const mode = request.input.mode;
                    return { themes: mode ? entries.filter(entry => (entry.modes ?? [entry.mode]).includes(mode)) : entries };
                }
                case THEME_ACTION_IDS.get: {
                    const { ref, include = [] } = request.input;
                    const entry = (await library.list()).find(row => sameStrictJsonValue(row.reference, ref));
                    if (!entry) return { ok: false as const, errorCode: 'theme_not_found', error: 'theme_not_found' };
                    const runtime = host.runtime;
                    const includeSurfaceMap = include.includes('surfaceMap') || include.includes('guide');
                    if ((include.includes('coverage') || includeSurfaceMap) && !runtime) return clientActionUnavailable(request.actionId);
                    const document = include.includes('document') || include.includes('coverage') || includeSurfaceMap ? await library.get(ref) : undefined;
                    if (document === null) return { ok: false as const, errorCode: 'theme_not_found', error: 'theme_not_found' };
                    if (include.includes('coverage') && document) await prepareThemeProfileCssAsync(document.profile);
                    const surfaceMap = includeSurfaceMap ? runtime?.surfaceMap?.(document!, entry.mode) : undefined;
                    if (includeSurfaceMap && !surfaceMap?.length) return clientActionUnavailable(request.actionId);
                    return { entry,
                        ...(include.includes('document') ? { document } : {}),
                        ...(include.includes('coverage') && document ? { coverage: runtime!.detailedCoverage(document) } : {}),
                        ...(include.includes('surfaceMap') ? { surfaceMap } : {}),
                        ...(include.includes('guide') ? { guide: themeGuide(surfaceMap!) } : {}),
                    };
                }
                case THEME_ACTION_IDS.tryOn: {
                    const runtime = host.runtime;
                    if (!runtime) return clientActionUnavailable(request.actionId);
                    const { origin, ...input } = request.input;
                    let previewOrigin: ThemeTryOnOrigin;
                    if (origin.kind === 'store' && origin.listing) {
                        const listing = origin.listing;
                        if (!host.withRegistryLifecycle) return clientActionUnavailable(request.actionId);
                        const acquired = await host.withRegistryLifecycle(lifecycle => lifecycle.prepareStorePreview(listing), request.context);
                        previewOrigin = { kind: 'store', listing, acquired };
                    } else if (origin.kind === 'store') {
                        const source = input.document?.profile.source;
                        if (source?.kind !== 'plugin') return { ok: false, errorCode: 'invalid_action_input', error: 'invalid_action_input' };
                        previewOrigin = { kind: 'store', reference: { kind: 'plugin', pluginId: source.pluginId, contributionId: source.contributionId } };
                    } else {
                        previewOrigin = { kind: origin.kind };
                    }
                    if (!input.document) {
                        const preview = runtime.preview.begin({ ...input, document: null, selection: null, origin: previewOrigin });
                        return { previewRef: preview.previewRef, coverage: { total: 0, native: 0, webOnly: 0, affectedSurfaces: [], hides: [] },
                            compatibility: { status: 'supported', unsupportedPaths: [] } };
                    }
                    await prepareThemeProfileCssAsync(input.document.profile);
                    const source = input.document.profile.source;
                    const reference: ThemeReference = source?.kind === 'plugin' ? { kind: 'plugin',
                        pluginId: source.pluginId, contributionId: source.contributionId }
                        : source?.kind === 'built-in' ? { kind: 'built-in', presetId: source.presetId }
                        : { kind: 'artifact', id: input.document.profile.id };
                    const existing = previewOrigin.kind !== 'store' || 'reference' in previewOrigin ? await library.get(reference) : null;
                    const selection = existing && sameStrictJsonValue(existing.raw, input.document.raw) ? reference : undefined;
                    if (previewOrigin.kind === 'store' && 'reference' in previewOrigin && !selection) {
                        return { ok: false, errorCode: 'invalid_action_input', error: 'invalid_action_input' };
                    }
                    const preview = runtime.preview.begin({ ...input, origin: previewOrigin,
                        ...(selection ? { selection } : {}) });
                    return { previewRef: preview.previewRef, coverage: runtime.coverage(input.document), compatibility: input.document.compatibility };
                }
                case THEME_ACTION_IDS.revert:
                    if (!host.runtime) return clientActionUnavailable(request.actionId);
                    host.runtime.preview.revert(request.input.previewRef);
                    return { restored: host.readSelection() };
                case THEME_ACTION_IDS.keep: {
                    if (!host.runtime) return clientActionUnavailable(request.actionId);
                    const preview = host.runtime.preview.read();
                    const result = await host.runtime.preview.keep(request.input.previewRef);
                    const clientId = host.clientId();
                    return { entry: result.entry, applied: { mode: preview!.mode, ...(clientId ? { clientId } : {}) }, undoHandle: result.undo! };
                }
                case THEME_ACTION_IDS.apply: {
                    const result = await library.select({ reference: request.input.ref, mode: request.input.mode });
                    const clientId = host.clientId();
                    return { applied: { mode: request.input.mode, ...(clientId ? { clientId } : {}) }, undoHandle: result.undo! };
                }
                case THEME_ACTION_IDS.save: {
                    if (request.input.ref && request.input.ref.kind !== 'artifact') {
                        return { ok: false as const, errorCode: 'theme_immutable_source', error: 'theme_immutable_source' };
                    }
                    const document = request.input.ref
                        ? mergeThemeProfileDocumentEdit(request.input.document, { id: request.input.ref.id })
                        : request.input.document;
                    const result = await library.save({ document });
                    if (!result.entry) return { ok: false as const, errorCode: 'theme_not_found', error: 'theme_not_found' };
                    return { entry: result.entry, ...(result.undo ? { undoHandle: result.undo } : {}) };
                }
                case THEME_ACTION_IDS.undo:
                    await library.undo(request.input.undoHandle);
                    return { restored: host.readSelection() };
                case THEME_ACTION_IDS.import: {
                    const imported = await importThemeProfileFromJson(request.input.file.text, { now: new Date().toISOString() });
                    if (!imported.ok) return { ok: false as const, errorCode: 'theme_document_invalid', error: 'theme_document_invalid' };
                    const result = await library.save({ document: imported.document });
                    if (!result.entry) return { ok: false as const, errorCode: 'theme_not_found', error: 'theme_not_found' };
                    return { entry: result.entry };
                }
                case THEME_ACTION_IDS.export: {
                    const document = await library.get(request.input.ref);
                    if (!document) return { ok: false as const, errorCode: 'theme_not_found', error: 'theme_not_found' };
                    return { file: { name: 'happier-theme.json', text: exportThemeProfileToJson(document) } };
                }
                case THEME_ACTION_IDS.duplicate:
                    return { entry: (await library.duplicate({ reference: request.input.ref })).entry! };
                case THEME_ACTION_IDS.sharePlugin:
                    return createShareThemePlugin(library)(request);
                case THEME_ACTION_IDS.delete:
                    if (request.input.ref.kind !== 'artifact') {
                        return { ok: false as const, errorCode: 'theme_immutable_source', error: 'theme_immutable_source' };
                    }
                    await library.delete(request.input.ref.id);
                    return { deleted: request.input.ref };
                default:
                    return { ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action' };
            }
        }, request.context.signal);
    };
}

function themeGuide(surfaceMap: readonly ThemeSurfacePaintDescriptor[]): string {
    return [
        'Try a theme on this device in the requested mode before keeping it. Ask how it looks. Revert restores the saved appearance and selection. A null document tries the mode\'s base theme.',
        'Keep and Apply fill the requested mode slot. Adaptive stays Adaptive; an explicit Light or Dark appearance switches to the requested mode. One Undo restores the mode and selection together. Keeping an existing library theme reuses its reference.',
        'Prefer editable colour tokens to CSS. CSS supports the published surface hooks; coverage reports which rules also work on native devices.',
        JSON.stringify({ tokens: THEME_PROFILE_TOKEN_DEFINITIONS, surfaceMap }),
    ].join('\n');
}

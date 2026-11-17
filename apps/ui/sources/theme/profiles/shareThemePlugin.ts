import type { ThemeProfileLibrary } from '@happier-dev/protocol/account/settings/themeProfiles';
import { THEME_ACTION_IDS, THEME_SHARE_PLUGIN_CHILD_ROLES, themeSharePluginChildInputs,
    type ThemeActionRequest, type ThemeActionOutput } from '@happier-dev/protocol/actions/themeActionFamily';
import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol/actions/executor/types';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';

type ShareRequest = Extract<ThemeActionRequest, { actionId: typeof THEME_ACTION_IDS.sharePlugin }>;
type ShareOutput = ThemeActionOutput<typeof THEME_ACTION_IDS.sharePlugin>;

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin authoring response');
    return value as Record<string, unknown>;
}
function childOutput(result: ActionExecuteResult, phase: 'scaffold' | 'pack', project: string): Readonly<{ ok: true; output: Record<string, unknown> }> | ActionExecuteFailure {
    if (!result.ok) return { ...result, details: { ...readRecord(result.details), phase, project } };
    const output = record(result.result);
    if (output.ok !== false) return { ok: true, output };
    const diagnostic = Array.isArray(output.diagnostics) && output.diagnostics.length ? record(output.diagnostics[0]) : undefined;
    return { ok: false, errorCode: typeof diagnostic?.code === 'string' ? diagnostic.code : 'action_failed',
        error: typeof diagnostic?.message === 'string' ? diagnostic.message : 'Plugin authoring failed',
        details: { phase, project, diagnostics: output.diagnostics } };
}

/** Initial Share and explicit pack recovery project the same authoring result. */
export function readThemePluginPackResult(result: ActionExecuteResult, project: string): ShareOutput | ActionExecuteFailure {
    const packed = childOutput(result, 'pack', project);
    if (!packed.ok) return packed;
    const archive = record(packed.output.package);
    if (typeof archive.archivePath !== 'string' || typeof archive.archiveDigest !== 'string') {
        throw new Error('Invalid plugin archive result');
    }
    return { project, archive: archive.archivePath, digest: archive.archiveDigest };
}

/** The selected Machine's existing authoring Actions own all filesystem effects. */
export function createShareThemePlugin(library: ThemeProfileLibrary) {
    return async (request: ShareRequest): Promise<ShareOutput | ActionExecuteFailure> => {
        const child = request.context.hostReviewedChild;
        if (!child) return { ok: false, errorCode: 'unsupported_action', error: 'Reviewed plugin authoring is unavailable' };
        const documents = await Promise.all(request.input.refs.map(ref => library.get(ref)));
        if (documents.some(document => !document)) return { ok: false, errorCode: 'theme_not_found', error: 'Theme not found' };
        // Pass retained data intact. The scaffold owns strict contribution admission and its diagnostic.
        const themes = documents.map(document => document!.raw);
        const inputs = themeSharePluginChildInputs(request.input);
        const scaffold = childOutput(await child.invoke({ action: 'plugins.scaffold',
            role: THEME_SHARE_PLUGIN_CHILD_ROLES.scaffold,
            input: projectNativeJsonValueForTransport({ ...inputs.scaffold, themes }) }), 'scaffold', request.input.path);
        if (!scaffold.ok) return scaffold;
        const paths = record(scaffold.output.createdPaths);
        if (typeof paths.targetDir !== 'string') throw new Error('Invalid plugin project result');
        return readThemePluginPackResult(await child.invoke({ action: 'plugins.pack', role: THEME_SHARE_PLUGIN_CHILD_ROLES.pack,
            input: { ...inputs.pack, locator: paths.targetDir } }), paths.targetDir);
    };
}

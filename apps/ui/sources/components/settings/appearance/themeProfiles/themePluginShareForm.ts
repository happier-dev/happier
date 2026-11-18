import { createActionInputForm, type ActionInputFormAccountLifetime, type ActionInputFormPresentation,
    type ActionInputFormSubmissionResult } from '@/components/plugins/actions/actionInputForm';
import { THEME_ACTION_IDS, ThemeActionInputSchemas, type ThemeActionInput, type ThemeActionOutput } from '@happier-dev/protocol/actions/themeActionFamily';
import { MachineTargetV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import type { ThemeLibraryEntry } from '@/theme/profiles/themeProfileTypes';
import { readThemePluginPackResult } from '@/theme/profiles/shareThemePlugin';

type ShareInput = ThemeActionInput<typeof THEME_ACTION_IDS.sharePlugin>;
export type ThemePluginShareResult = ThemeActionOutput<typeof THEME_ACTION_IDS.sharePlugin>;
export type ThemePluginShareLabels = Readonly<{ share: string; machine: string; path: string; themes?: string; retry?: string }>;
export type ThemePluginShareExecute = (id: typeof THEME_ACTION_IDS.sharePlugin, input: ShareInput,
    operation?: Readonly<{ signal?: AbortSignal }>) => Promise<ThemePluginShareResult>;
type ShareSubmission = ActionInputFormSubmissionResult & Readonly<{ project?: string; shared?: ThemePluginShareResult }>;

/** Both editor and library share through the same selected-Machine Action form. */
export function createThemePluginShareForm(params: Readonly<{
    refs: ShareInput['refs'];
    themes?: readonly Pick<ThemeLibraryEntry, 'name' | 'reference'>[];
    serverId: string;
    labels: ThemePluginShareLabels;
    execute: ThemePluginShareExecute;
    pack?: (input: Readonly<{ machineId: string; locator: string }>,
        operation?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;
    accountLifetime?: ActionInputFormAccountLifetime | null;
    signal?: AbortSignal;
    onShared?: (result: ThemePluginShareResult) => void;
}>) {
    let recovery: Readonly<{ machineId: string; project: string }> | null = null;
    const presentation: { title: string; description: string | null; inputHints: ActionInputFormPresentation['inputHints'] } = {
        title: params.labels.share, description: null, inputHints: { fields: [
            ...(params.themes ? [{ path: 'refs', title: params.labels.themes ?? params.labels.share,
                widget: 'multiselect' as const, required: true,
                options: params.themes.map(entry => ({ value: entry.reference, label: entry.name })) }] : []),
            { path: 'machine', title: params.labels.machine, widget: 'select', required: true, inputType: { hostType: 'machine' } },
            { path: 'path', title: params.labels.path, widget: 'text', required: true },
        ], submitLabel: params.labels.share },
    };
    return createActionInputForm<ShareSubmission>({
        presentation,
        initialInput: params.themes ? { refs: params.refs } : {},
        accountLifetime: params.accountLifetime,
        signal: params.signal,
        submit: async (candidate, { signal }): Promise<ShareSubmission> => {
            if (recovery && params.pack) {
                try {
                    const result = readThemePluginPackResult({ ok: true,
                        result: await params.pack({ machineId: recovery.machineId, locator: recovery.project }, { signal }) }, recovery.project);
                    if ('ok' in result) return { ok: false, code: result.errorCode, phase: 'pack', project: recovery.project };
                    params.onShared?.(result);
                    return { ok: true, shared: result };
                } catch (error) {
                    return { ok: false, code: readActionErrorCodeV1(error) ?? 'action_failed', phase: 'pack', project: recovery.project };
                }
            }
            const target = MachineTargetV1Schema.safeParse(candidate.machine);
            if (!target.success || target.data.serverId !== params.serverId) return { ok: false };
            const input = ThemeActionInputSchemas[THEME_ACTION_IDS.sharePlugin].safeParse({
                refs: params.themes ? candidate.refs : params.refs, machineId: target.data.machineId, path: candidate.path,
            });
            if (!input.success) return { ok: false };
            let shared: ThemePluginShareResult;
            try {
                shared = await params.execute(THEME_ACTION_IDS.sharePlugin, input.data, { signal });
            } catch (error) {
                // The mounted Action executor already preserved its producer's failure details.
                const details = readRecord(readRecord(error).details);
                const phase = typeof details.phase === 'string' ? details.phase : undefined;
                const project = typeof details.project === 'string' ? details.project : undefined;
                if (phase === 'pack' && project && params.pack) {
                    recovery = { machineId: target.data.machineId, project };
                    presentation.description = `${params.labels.path}: ${project}`;
                    presentation.inputHints = { fields: [], submitLabel: params.labels.retry ?? params.labels.share };
                }
                return { ok: false, code: readActionErrorCodeV1(error) ?? 'action_failed', ...(phase ? { phase } : {}), ...(project ? { project } : {}) };
            }
            params.onShared?.(shared);
            return { ok: true, shared };
        },
    });
}
